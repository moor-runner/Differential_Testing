package com.duipai.api;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;

import java.nio.file.Path;
import java.util.*;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "duipai.token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
@AutoConfigureMockMvc
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class DebugControllerTest {
    private static final String TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String SOLUTION = """
            import java.util.*;

            public class Main {
                public static void main(String[] args) {
                    Scanner in = new Scanner(System.in);
                    int n = in.nextInt();
                    long sum = 0;
                    for (int i = 0; i < n; i++) {
                        sum += in.nextInt();
                    }
                    System.out.println(sum);
                }
            }
            """;
    @TempDir static Path dataDirectory;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties) { properties.add("duipai.data-dir", () -> dataDirectory.toString()); }
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;

    @Test
    void savesBreakpointsPerProgramAndDropsThemWithTheProblem() throws Exception {
        String id = (String) create("断点保存").get("id");
        mvc.perform(get("/api/problems/" + id + "/breakpoints")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/problems/" + id + "/breakpoints").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk())
                .andExpect(content().json("{\"generator\":[],\"brute\":[],\"optimized\":[]}"));
        putJson("/api/problems/" + id + "/breakpoints", Map.of("optimized", List.of(9, 3, 9), "brute", List.of(2))).andExpect(status().isOk())
                .andExpect(content().json("{\"generator\":[],\"brute\":[2],\"optimized\":[3,9]}"));
        mvc.perform(get("/api/problems/" + id + "/breakpoints").header("X-Duipai-Token", TOKEN)).andExpect(jsonPath("$.optimized[1]").value(9));
        for (Object invalid : List.of(List.of(0), List.of(-3), List.of("x"), List.of(1.5), "7", Collections.nCopies(1001, 1)))
            putJson("/api/problems/" + id + "/breakpoints", Map.of("optimized", invalid)).andExpect(status().isBadRequest());
        putJson("/api/problems/missing/breakpoints", Map.of()).andExpect(status().isNotFound());
        mvc.perform(delete("/api/problems/" + id).header("X-Duipai-Token", TOKEN)).andExpect(status().isNoContent());
        mvc.perform(get("/api/problems/" + id + "/breakpoints").header("X-Duipai-Token", TOKEN)).andExpect(status().isNotFound());
    }

    @Test
    void debugsTheSavedSolverOnOneCaseOverHttp() throws Exception {
        Map<String, Object> problem = create("调试用例");
        String id = (String) problem.get("id");
        codes(problem).put("optimized", SOLUTION);
        putJson("/api/problems/" + id, problem).andExpect(status().isOk());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("problemId", id); body.put("role", "optimized"); body.put("label", "样例 1");
        body.put("input", "3\n1 2 3"); body.put("expected", "6"); body.put("breakpoints", List.of(9));
        Map<String, Object> started = read(postJson("/api/debug", body).andExpect(status().isCreated()).andReturn());
        String session = (String) started.get("id");
        assertThat(started.get("problemId")).isEqualTo(id);
        assertThat(started.get("role")).isEqualTo("optimized");
        assertThat(started.get("label")).isEqualTo("样例 1");

        Map<String, Object> paused = await(session, snapshot -> "PAUSED".equals(snapshot.get("state")));
        Map<?, ?> pause = (Map<?, ?>) paused.get("pause");
        assertThat(pause.get("line")).isEqualTo(9);
        assertThat(pause.get("reason")).isEqualTo("breakpoint");
        assertThat(json.writeValueAsString(paused.get("breakpoints"))).isEqualTo("[{\"line\":9,\"verified\":true}]");
        int generation = (Integer) paused.get("generation");
        Map<String, Object> frame = read(mvc.perform(get("/api/debug/" + session + "/frames/0/variables").param("generation", String.valueOf(generation)).header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andReturn());
        assertThat(json.writeValueAsString(frame.get("variables"))).contains("\"name\":\"n\"", "\"value\":\"3\"", "\"name\":\"sum\"");
        mvc.perform(get("/api/debug/" + session + "/frames/0/variables").param("generation", String.valueOf(generation - 1)).header("X-Duipai-Token", TOKEN)).andExpect(status().isConflict());
        mvc.perform(get("/api/debug/" + session + "/variables/12345").param("generation", String.valueOf(generation)).header("X-Duipai-Token", TOKEN)).andExpect(status().isBadRequest());

        postJson("/api/debug/" + session + "/step", Map.of("kind", "sideways")).andExpect(status().isBadRequest());
        postJson("/api/debug/" + session + "/run-to-line", Map.of("line", 0)).andExpect(status().isBadRequest());
        Map<String, Object> stepped = settle(session, read(postJson("/api/debug/" + session + "/step", Map.of("kind", "over")).andExpect(status().isOk()).andReturn()));
        assertThat(((Map<?, ?>) stepped.get("pause")).get("line")).isEqualTo(8);
        putJson("/api/debug/" + session + "/breakpoints", Map.of("lines", List.of())).andExpect(status().isOk()).andExpect(jsonPath("$.breakpoints.length()").value(0));
        mvc.perform(post("/api/debug/" + session + "/resume").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk());
        Map<String, Object> done = await(session, snapshot -> "TERMINATED".equals(snapshot.get("state")));
        assertThat(((Map<?, ?>) done.get("result")).get("verdict")).isEqualTo("PASS");
        mvc.perform(post("/api/debug/" + session + "/resume").header("X-Duipai-Token", TOKEN)).andExpect(status().isConflict());
        mvc.perform(post("/api/debug/" + session + "/pause").header("X-Duipai-Token", TOKEN)).andExpect(status().isConflict());
        mvc.perform(get("/api/debug/" + session + "/console").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk())
                .andExpect(jsonPath("$.chunks[0].stream").value("out")).andExpect(jsonPath("$.chunks[0].text").value(containsString("6")));

        MvcResult sse = mvc.perform(get("/api/debug/" + session + "/events").header("X-Duipai-Token", TOKEN)).andExpect(request().asyncStarted()).andReturn();
        mvc.perform(asyncDispatch(sse)).andExpect(status().isOk())
                .andExpect(content().string(containsString("event:output"))).andExpect(content().string(containsString("event:state")))
                .andExpect(content().string(containsString("TERMINATED")));

        body.put("role", "generator");
        postJson("/api/debug", body).andExpect(status().isBadRequest());
        body.put("role", "brute"); body.put("breakpoints", List.of(0));
        postJson("/api/debug", body).andExpect(status().isBadRequest());
        body.put("breakpoints", List.of()); body.put("problemId", "missing");
        postJson("/api/debug", body).andExpect(status().isNotFound());
        mvc.perform(get("/api/debug/missing").header("X-Duipai-Token", TOKEN)).andExpect(status().isNotFound());
    }

    @Test
    void deletingTheProblemStopsItsSession() throws Exception {
        Map<String, Object> problem = create("删除时停止");
        String id = (String) problem.get("id");
        codes(problem).put("brute", "public class Main { public static void main(String[] a) { while (true) { } } }");
        putJson("/api/problems/" + id, problem).andExpect(status().isOk());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("problemId", id); body.put("role", "brute"); body.put("input", ""); body.put("expected", null);
        String session = (String) read(postJson("/api/debug", body).andExpect(status().isCreated()).andReturn()).get("id");
        await(session, snapshot -> "RUNNING".equals(snapshot.get("state")));
        Map<String, Object> paused = read(mvc.perform(post("/api/debug/" + session + "/pause").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andReturn());
        assertThat(((Map<?, ?>) paused.get("pause")).get("reason")).isEqualTo("pause");
        mvc.perform(delete("/api/problems/" + id).header("X-Duipai-Token", TOKEN)).andExpect(status().isNoContent());
        Map<String, Object> done = await(session, snapshot -> "TERMINATED".equals(snapshot.get("state")));
        assertThat(((Map<?, ?>) done.get("result")).get("verdict")).isEqualTo("STOPPED");
    }

    private Map<String, Object> await(String session, Predicate<Map<String, Object>> condition) throws Exception {
        long deadline = System.nanoTime() + 30_000_000_000L;
        while (true) {
            Map<String, Object> snapshot = read(mvc.perform(get("/api/debug/" + session).header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andReturn());
            if (condition.test(snapshot)) return snapshot;
            assertThat(System.nanoTime()).as("等待调试状态：" + snapshot).isLessThan(deadline);
            Thread.sleep(25);
        }
    }

    private Map<String, Object> settle(String session, Map<String, Object> reply) throws Exception {
        return "RUNNING".equals(reply.get("state")) ? await(session, snapshot -> !"RUNNING".equals(snapshot.get("state"))) : reply;
    }

    @SuppressWarnings("unchecked") private static Map<String, String> codes(Map<String, Object> problem) { return (Map<String, String>) problem.get("codes"); }
    private Map<String, Object> create(String title) throws Exception {
        return read(postJson("/api/problems", Map.of("title", title)).andExpect(status().isCreated()).andReturn());
    }
    private ResultActions postJson(String path, Object body) throws Exception {
        return mvc.perform(post(path).header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(body)));
    }
    private ResultActions putJson(String path, Object body) throws Exception {
        return mvc.perform(put(path).header("X-Duipai-Token", TOKEN).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(body)));
    }
    private Map<String, Object> read(MvcResult result) throws Exception { return json.readValue(result.getResponse().getContentAsByteArray(), new TypeReference<LinkedHashMap<String, Object>>() { }); }
}
