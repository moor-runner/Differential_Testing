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

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "duipai.token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
@AutoConfigureMockMvc
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class TestCaseControllerTest {
    private static final String TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    @TempDir static Path dataDirectory;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties) { properties.add("duipai.data-dir", () -> dataDirectory.toString()); }
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;

    @Test
    void savesCustomCasesPerProblemAndDeletesThemWithTheProblem() throws Exception {
        String id = (String) create("自定义用例").get("id");
        mvc.perform(get("/api/problems/" + id + "/tests")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/problems/" + id + "/tests").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andExpect(content().json("[]"));
        List<Map<String, Object>> cases = List.of(Map.of("id", "a", "input", "3\n1 2 3\n", "expected", "6"), Map.of("id", "b", "input", "中文", "expected", ""));
        putJson("/api/problems/" + id + "/tests", cases).andExpect(status().isOk());
        mvc.perform(get("/api/problems/" + id + "/tests").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2)).andExpect(jsonPath("$[0].input").value("3\n1 2 3\n")).andExpect(jsonPath("$[1].input").value("中文"));
        putJson("/api/problems/" + id + "/tests", List.of(Map.of("id", "a", "input", "1"), Map.of("id", "a", "input", "", "expected", ""))).andExpect(status().isBadRequest());
        putJson("/api/problems/" + id + "/tests", List.of(Map.of("id", "a", "input", "1", "expected", "1"), Map.of("id", "a", "input", "", "expected", ""))).andExpect(status().isBadRequest());
        putJson("/api/problems/missing/tests", List.of()).andExpect(status().isNotFound());
        Map<String, Object> generated = Map.of("id", "ai", "input", "1\n5\n", "expected", "5", "source", "ai", "category", "边界", "note", "n 取最小值");
        putJson("/api/problems/" + id + "/tests", List.of(generated)).andExpect(status().isOk());
        mvc.perform(get("/api/problems/" + id + "/tests").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk())
                .andExpect(jsonPath("$[0].source").value("ai")).andExpect(jsonPath("$[0].category").value("边界")).andExpect(jsonPath("$[0].note").value("n 取最小值"));
        putJson("/api/problems/" + id + "/tests", List.of(Map.of("id", "x", "input", "1", "expected", "", "source", "web"))).andExpect(status().isBadRequest());
        putJson("/api/problems/" + id + "/tests", List.of(Map.of("id", "x", "input", "1", "expected", "", "category", "类".repeat(33)))).andExpect(status().isBadRequest());
        mvc.perform(delete("/api/problems/" + id).header("X-Duipai-Token", TOKEN)).andExpect(status().isNoContent());
        mvc.perform(get("/api/problems/" + id + "/tests").header("X-Duipai-Token", TOKEN)).andExpect(status().isNotFound());
    }

    @Test
    void runsTheSavedSolverOnSamplesAndReportsEachCase() throws Exception {
        Map<String, Object> problem = create("运行用例");
        String id = (String) problem.get("id");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("problemId", id); body.put("role", "optimized"); body.put("runId", "api-run");
        List<Map<String, Object>> cases = new ArrayList<>();
        cases.add(Map.of("input", "3\n1 2 3", "expected", "6"));
        cases.add(Map.of("input", "1\n5\n", "expected", "4"));
        Map<String, Object> unchecked = new HashMap<>(); unchecked.put("input", "2\n-1 -2"); unchecked.put("expected", null); cases.add(unchecked);
        body.put("cases", cases);
        Map<String, Object> run = read(postJson("/api/tests/run", body).andExpect(status().isOk()).andReturn());
        assertThat(run.get("id")).isEqualTo("api-run");
        assertThat(run.get("problemId")).isEqualTo(id);
        assertThat(run.get("verdict")).isEqualTo("FAIL");
        assertThat(run.get("timeoutMs")).isEqualTo(2000);
        List<?> results = (List<?>) run.get("results");
        assertThat(results.stream().map(result -> String.valueOf(((Map<?, ?>) result).get("verdict"))).toList()).containsExactly("PASS", "WA", "UNCHECKED");
        assertThat(((String) ((Map<?, ?>) results.get(2)).get("stdout")).strip()).isEqualTo("-3");
        mvc.perform(post("/api/tests/api-run/cancel").header("X-Duipai-Token", TOKEN)).andExpect(status().isOk()).andExpect(jsonPath("$.cancelled").value(false));

        body.put("role", "generator");
        postJson("/api/tests/run", body).andExpect(status().isBadRequest());
        body.put("role", "brute"); body.put("cases", List.of());
        postJson("/api/tests/run", body).andExpect(status().isBadRequest());
        @SuppressWarnings("unchecked") Map<String, String> codes = (Map<String, String>) problem.get("codes");
        codes.put("brute", "public class Main { syntax error }");
        putJson("/api/problems/" + id, problem).andExpect(status().isOk());
        body.put("cases", List.of(Map.of("input", "1\n1", "expected", "1")));
        Map<String, Object> failed = read(postJson("/api/tests/run", body).andExpect(status().isOk()).andReturn());
        assertThat(failed.get("verdict")).isEqualTo("CE");
        assertThat(json.writeValueAsString(failed.get("compileErrors"))).contains("brute", "line");
    }

    @Test
    void comparesBruteAndOptimizedAndChecksBruteAgainstExpectedOutput() throws Exception {
        String id = (String) create("对比用例").get("id");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("problemId", id); body.put("role", "compare"); body.put("runId", "compare-run");
        Map<String, Object> unchecked = new HashMap<>(); unchecked.put("input", "2\n-1 -2"); unchecked.put("expected", null);
        body.put("cases", List.of(Map.of("input", "3\n1 2 3", "expected", "6"), Map.of("input", "1\n5", "expected", "4"), unchecked));
        Map<String, Object> run = read(postJson("/api/tests/run", body).andExpect(status().isOk()).andReturn());
        assertThat(run.get("role")).isEqualTo("compare");
        assertThat(run.get("verdict")).isEqualTo("FAIL");
        assertThat(run.get("timeoutMs")).isEqualTo(2000);
        assertThat(run.get("bruteTimeoutMs")).isEqualTo(10000);
        List<?> results = (List<?>) run.get("results");
        assertThat(results.stream().map(result -> String.valueOf(((Map<?, ?>) result).get("verdict"))).toList()).containsExactly("PASS", "BRUTE_WA", "PASS");
        assertThat(((String) ((Map<?, ?>) ((Map<?, ?>) results.get(2)).get("brute")).get("stdout")).strip()).isEqualTo("-3");
    }

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
