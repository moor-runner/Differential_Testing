package com.duipai.api;

import com.duipai.config.DataPaths;
import com.duipai.service.ProblemService;
import com.duipai.storage.JsonStorage;
import com.duipai.storage.ProblemMapper;
import com.duipai.storage.RunMapper;
import com.duipai.storage.RunRow;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.*;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "duipai.token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
@AutoConfigureMockMvc
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ApiIntegrationTest {
    private static final String TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    @TempDir static Path dataDirectory;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties) { properties.add("duipai.data-dir", () -> dataDirectory.toString()); }
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired ProblemMapper problemMapper;
    @Autowired JsonStorage jsonStorage;
    @Autowired DataPaths paths;
    @Autowired RunMapper runMapper;

    @Test
    void protectsEveryApiResourceAndRejectsCrossPortCookieRequests() throws Exception {
        for (String path : List.of("/api/health", "/api/problems", "/api/settings/layout", "/api/jobs/missing", "/api/jobs/missing/events", "/api/runs/missing/export/input", "/api/images/missing.png"))
            mvc.perform(get(path)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api;matrix/health")).andExpect(status().isUnauthorized());
        mvc.perform(get("/%61pi/health").with(request -> { request.setServletPath("/api/health"); return request; })).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/shutdown")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/health").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ok"));
        mvc.perform(get("/api/health").cookie(new Cookie("duipai_token", TOKEN))).andExpect(status().isOk());
        mvc.perform(post("/api/problems").cookie(new Cookie("duipai_token", TOKEN)).header("Origin", "http://localhost:8181").contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"CSRF\"}"))
                .andExpect(status().isForbidden());
        mvc.perform(get("/api/health").header("X-Duipai-Token", TOKEN).header("Origin", "https://example.com")).andExpect(status().isForbidden());
        mvc.perform(get("/api/health").header("X-Duipai-Token", TOKEN).with(request -> { request.setServerName("evil.example"); return request; })).andExpect(status().isForbidden());
        mvc.perform(get("/api/health").header("X-Duipai-Token", TOKEN).header("Origin", "http://localhost"))
                .andExpect(status().isOk()).andExpect(header().string("X-Content-Type-Options", "nosniff"));
    }

    @Test
    void storesUnicodeProblemAndSigned64BitSeedWithoutPrecisionLoss() throws Exception {
        Map<String, Object> problem = create("测试题目中文");
        String id = (String) problem.get("id");
        problem.put("statement", "# 中文题面\n公式 $a+b$\n![示意](/api/images/example.png)");
        Map<String, Object> settings = settings(problem);
        settings.put("rounds", 1); settings.put("startSeed", "9223372036854775807");
        mvc.perform(put("/api/problems/" + id).header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(problem)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.settings.startSeed").value("9223372036854775807"));
        ProblemService reloaded = new ProblemService(problemMapper, jsonStorage);
        assertThat(reloaded.get(id).get("statement")).isEqualTo(problem.get("statement"));
        assertThat(settings(reloaded.get(id)).get("startSeed")).isEqualTo("9223372036854775807");
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + paths.database()); var query = connection.prepareStatement("SELECT title,settings_json FROM problems WHERE id=?")) {
            query.setString(1, id);
            try (var rows = query.executeQuery()) { assertThat(rows.next()).isTrue(); assertThat(rows.getString(1)).isEqualTo("测试题目中文"); assertThat(rows.getString(2)).contains("9223372036854775807"); }
        }
        settings.put("startSeed", 123);
        mvc.perform(put("/api/problems/" + id).header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(problem))).andExpect(status().isBadRequest());
        settings.put("startSeed", "9223372036854775807"); settings.put("rounds", 2);
        mvc.perform(put("/api/problems/" + id).header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(problem))).andExpect(status().isBadRequest());
        mvc.perform(delete("/api/problems/" + id).header("X-Duipai-Token", TOKEN)).andExpect(status().isNoContent());
        mvc.perform(get("/api/problems/" + id).header("X-Duipai-Token", TOKEN)).andExpect(status().isNotFound());
    }

    @Test
    void persistsLayoutAndTranscodesImagesWhileRejectingFakeImagePayloads() throws Exception {
        mvc.perform(put("/api/settings/layout").header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content("{\"main\":[18,24,58],\"results\":38}"))
                .andExpect(status().isOk());
        mvc.perform(get("/api/settings/layout").header("X-Duipai-Token", TOKEN)).andExpect(jsonPath("$.main[2]").value(58));
        assertThat(paths.settings()).hasContent("{\"layout\":{\"main\":[18,24,58],\"results\":38}}");
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB), "png", png);
        MvcResult uploaded = mvc.perform(multipart("/api/images").file(new MockMultipartFile("file", "../../outside.png", "image/png", png.toByteArray())).header("X-Duipai-Token", TOKEN))
                .andExpect(status().isOk()).andReturn();
        String url = (String) read(uploaded).get("url");
        assertThat(url).matches("/api/images/[0-9a-f-]{36}\\.png");
        mvc.perform(get(url).header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andExpect(content().contentType(MediaType.IMAGE_PNG));
        mvc.perform(get(url)).andExpect(status().isUnauthorized());
        mvc.perform(multipart("/api/images").file(new MockMultipartFile("file", "attack.png", "image/png", "<script>alert(1)</script>".getBytes())).header("X-Duipai-Token", TOKEN)).andExpect(status().isBadRequest());
    }

    @Test
    void exposesAllHistoryWithoutLoadingLargeOutputOrSourceFields() throws Exception {
        String problemId = (String) create("完整历史测试").get("id");
        for (int i = 0; i < 101; i++) {
            String id = UUID.randomUUID().toString();
            Map<String, Object> snapshot = new LinkedHashMap<>(Map.of("id", id, "problemId", problemId, "state", "FINISHED", "verdict", "PASS", "completed", i + 1, "total", i + 1));
            if (i == 100) {
                snapshot.put("input", "x".repeat(1024 * 1024)); snapshot.put("codes", Map.of("optimized", "x".repeat(1024 * 1024)));
                snapshot.put("generator", Map.of("stdout", "x".repeat(1024 * 1024))); snapshot.put("compileErrors", List.of(Map.of("output", "x".repeat(1024 * 1024))));
            }
            runMapper.save(new RunRow(id, problemId, json.writeValueAsString(snapshot), String.format("2026-10-06T00:00:%03dZ", i)));
        }
        MvcResult history = mvc.perform(get("/api/problems/" + problemId + "/runs").header("X-Duipai-Token", TOKEN))
                .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(101)).andExpect(jsonPath("$[0].completed").value(101))
                .andExpect(jsonPath("$[0].codes").doesNotExist()).andExpect(jsonPath("$[0].input").doesNotExist()).andExpect(jsonPath("$[0].generator").doesNotExist()).andReturn();
        assertThat(history.getResponse().getContentAsByteArray().length).isLessThan(50_000);
    }

    @Test
    void replaysAndPersistsImmutableRunSourcesAndSettingsWithFinalSseAndExport() throws Exception {
        Map<String, Object> problem = create("复现测试");
        String id = (String) problem.get("id");
        settings(problem).put("rounds", 5); settings(problem).put("parallelism", 1); settings(problem).put("startSeed", "9007199254740993");
        save(problem);
        String original = codes(problem).get("optimized");
        Map<String, Object> initial = start(id, "9007199254740993");
        assertThat(initial.get("state")).isEqualTo("COMPILING");
        String runId = (String) initial.get("id");
        Map<String, Object> finalResult = finish(runId);
        assertThat(finalResult.get("verdict")).isEqualTo("PASS");
        assertThat(finalResult.get("seed")).isEqualTo("9007199254740993");
        assertThat(finalResult.get("input")).isNotNull();
        assertThat(finalResult.get("brute")).isNotNull();
        codes(problem).put("optimized", "public class Main { public static void main(String[] args) { System.out.println(0); } }");
        settings(problem).put("startSeed", "1"); save(problem);
        Map<String, Object> durable = read(mvc.perform(get("/api/runs/" + runId).header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andReturn());
        assertThat(codes(durable).get("optimized")).isEqualTo(original);
        assertThat(settings(durable).get("startSeed")).isEqualTo("9007199254740993");
        mvc.perform(get("/api/problems/" + id + "/runs").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andExpect(jsonPath("$[0].id").value(runId)).andExpect(jsonPath("$[0].codes").doesNotExist());
        mvc.perform(get("/api/runs/" + runId + "/export/input").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andExpect(header().exists("Content-Disposition")).andExpect(content().string((String) durable.get("input")));
        MvcResult sse = mvc.perform(get("/api/jobs/" + runId + "/events").header("X-Duipai-Token", TOKEN)).andExpect(request().asyncStarted()).andReturn();
        mvc.perform(asyncDispatch(sse)).andExpect(status().isOk()).andExpect(content().string(org.hamcrest.Matchers.containsString("event:progress"))).andExpect(content().string(org.hamcrest.Matchers.containsString("FINISHED")));
    }

    @Test
    void rejectsConcurrentRunsAndActiveDeletionThenCancelsAndPersists() throws Exception {
        Map<String, Object> problem = create("取消测试");
        String id = (String) problem.get("id");
        codes(problem).put("generator", "public class Main { public static void main(String[] args) throws Exception { Thread.sleep(10000); System.out.println(1); } }");
        settings(problem).put("rounds", 100); settings(problem).put("parallelism", 1); save(problem);
        String runId = (String) start(id, null).get("id");
        mvc.perform(post("/api/jobs").header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(Map.of("problemId", id)))).andExpect(status().isConflict());
        mvc.perform(delete("/api/problems/" + id).header("X-Duipai-Token", TOKEN)).andExpect(status().isConflict());
        mvc.perform(post("/api/jobs/" + runId + "/cancel").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk());
        assertThat(finish(runId).get("verdict")).isEqualTo("CANCELLED");
        mvc.perform(delete("/api/problems/" + id).header("X-Duipai-Token", TOKEN)).andExpect(status().isNoContent());
        mvc.perform(get("/api/runs/" + runId).header("X-Duipai-Token", TOKEN)).andExpect(status().isNotFound());
    }

    @Test
    void keepsCompileErrorsInTheirCorrectRole() throws Exception {
        Map<String, Object> problem = create("编译错误测试");
        codes(problem).put("brute", "public class Main { syntax error }"); save(problem);
        String runId = (String) start((String) problem.get("id"), null).get("id");
        Map<String, Object> snapshot = finish(runId);
        assertThat(snapshot.get("verdict")).isEqualTo("CE");
        assertThat((List<?>) snapshot.get("compileErrors")).isNotEmpty();
        assertThat(json.writeValueAsString(snapshot.get("compileErrors"))).contains("brute", "line", "column");
        assertThat(codes(snapshot).get("brute")).isEqualTo("public class Main { syntax error }");
    }

    private Map<String, Object> create(String title) throws Exception {
        return read(mvc.perform(post("/api/problems").header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(Map.of("title", title)))).andExpect(status().isCreated()).andReturn());
    }
    private void save(Map<String, Object> problem) throws Exception {
        mvc.perform(put("/api/problems/" + problem.get("id")).header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(problem))).andExpect(status().isOk());
    }
    private Map<String, Object> start(String id, String seed) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>(); body.put("problemId", id); if (seed != null) body.put("replaySeed", seed);
        return read(mvc.perform(post("/api/jobs").header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(body))).andExpect(status().isCreated()).andReturn());
    }
    private Map<String, Object> finish(String id) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos();
        while (System.nanoTime() < deadline) {
            Map<String, Object> snapshot = read(mvc.perform(get("/api/jobs/" + id).header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andReturn());
            if ("FINISHED".equals(snapshot.get("state"))) return snapshot;
            Thread.sleep(60);
        }
        throw new AssertionError("Job did not finish in 30 seconds: " + id);
    }
    private Map<String, Object> read(MvcResult result) throws Exception { return json.readValue(result.getResponse().getContentAsByteArray(), new TypeReference<LinkedHashMap<String, Object>>() { }); }
    @SuppressWarnings("unchecked") private Map<String, Object> settings(Map<String, Object> value) { return (Map<String, Object>) value.get("settings"); }
    @SuppressWarnings("unchecked") private Map<String, String> codes(Map<String, Object> value) { return (Map<String, String>) value.get("codes"); }
}
