package com.duipai.service;

import com.duipai.config.DataPaths;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.*;

class AiTestCaseServiceTest {
    @TempDir Path directory;
    private final ObjectMapper json = new ObjectMapper();
    private final AtomicReference<JsonNode> request = new AtomicReference<>();
    private final AtomicReference<String> reply = new AtomicReference<>();
    private HttpServer server;
    private ExecutorService serverThreads;
    private AiRequestTracker tracker;
    private AiTestCaseService service;

    @BeforeEach
    void startProvider() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        serverThreads = Executors.newVirtualThreadPerTaskExecutor();
        server.setExecutor(serverThreads);
        server.createContext("/", exchange -> {
            try {
                request.set(json.readTree(exchange.getRequestBody()));
                byte[] bytes = json.writeValueAsBytes(Map.of("choices", List.of(Map.of("message", Map.of("content", reply.get()), "finish_reason", "stop"))));
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            } finally { exchange.close(); }
        });
        server.start();
        AiSettingsService settings = new AiSettingsService(new DataPaths(directory.toString()), json, new AiSettingsServiceTest.TestKeyProtector());
        settings.save(new AiSettingsService.Update("http://127.0.0.1:" + server.getAddress().getPort() + "/v1", "provider-model", "sk-fake-http-test", false));
        tracker = new AiRequestTracker();
        AiStatementService ai = new AiStatementService(settings, json, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1))
                .followRedirects(HttpClient.Redirect.NEVER).build(), Duration.ofSeconds(5), tracker);
        service = new AiTestCaseService(ai, json);
    }

    @AfterEach
    void stopProvider() {
        if (server != null) server.stop(0);
        if (serverThreads != null) serverThreads.close();
    }

    @Test
    void sendsOnlyTheStatementWithTheTestDesignPromptAndReturnsNormalizedCases() throws Exception {
        reply.set("""
                ```json
                {"cases":[
                  {"category":"边界","input":"1\\r\\n5","expected":"5\\n","note":"n 取最小值"},
                  {"category":"溢出","input":["2","2147483647 2147483647"],"expected":4294967294,"note":"和超过 int"},
                  {"input":"3\\n1 1 1\\n","expected":null},
                  {"category":"边界","input":"1\\n5\\n","expected":"5","note":"重复输入"}
                ]}
                ```""");
        String statement = "给定 n 个整数，输出它们的和。\n1 <= n <= 10";
        String id = UUID.randomUUID().toString();
        List<AiTestCaseService.GeneratedCase> cases = service.generate(statement, id).cases();
        assertThat(cases).containsExactly(
                new AiTestCaseService.GeneratedCase("边界", "1\n5\n", "5", "n 取最小值"),
                new AiTestCaseService.GeneratedCase("溢出", "2\n2147483647 2147483647\n", "4294967294", "和超过 int"),
                new AiTestCaseService.GeneratedCase("一般", "3\n1 1 1\n", null, ""));
        assertThat(request.get().path("messages").path(0).path("content").asText())
                .contains("只输出一个 JSON 对象", "必须与实际给出的数据个数完全一致", "填 null", "不要编写解法代码");
        assertThat(request.get().path("messages").path(1).path("content").asText()).isEqualTo(statement);
        assertThat(tracker.get(id).operation()).isEqualTo("testcases");
        assertThat(tracker.get(id).state()).isEqualTo("SUCCEEDED");
    }

    @Test
    void rejectsRepliesWithoutUsableCasesAndMarksTheRequestFailed() {
        for (String invalid : List.of("我无法生成用例", "{\"cases\":", "{\"tests\":[]}", "{\"cases\":[{\"input\":\"  \"},{\"input\":{\"n\":1}}]}")) {
            reply.set(invalid);
            String id = UUID.randomUUID().toString();
            assertThatThrownBy(() -> service.generate("题面", id)).isInstanceOfSatisfying(ResponseStatusException.class,
                    error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY));
            assertThat(tracker.get(id).state()).isEqualTo("FAILED");
        }
    }

    @Test
    void validatesTheStatementBeforeCallingTheProvider() {
        for (String invalid : new String[]{null, " ", "x".repeat(AiStatementService.MAX_STATEMENT_CHARACTERS + 1)})
            assertThatThrownBy(() -> service.generate(invalid, null)).isInstanceOf(IllegalArgumentException.class);
        assertThat(request.get()).isNull();
    }

    @Test
    void boundsTheNumberAndSizeOfGeneratedCases() throws Exception {
        StringBuilder many = new StringBuilder("{\"cases\":[");
        for (int i = 0; i < 30; i++) many.append(i == 0 ? "" : ",").append("{\"input\":\"").append(i).append("\",\"category\":\"").append("类".repeat(40)).append("\"}");
        List<AiTestCaseService.GeneratedCase> cases = AiTestCaseService.parse(json, many.append("]}").toString());
        assertThat(cases).hasSize(AiTestCaseService.MAX_CASES);
        assertThat(cases.getFirst().category()).hasSize(AiTestCaseService.MAX_CATEGORY_CHARACTERS);
        String huge = "{\"cases\":[{\"input\":\"" + "9".repeat(AiTestCaseService.MAX_INPUT_CHARACTERS + 1) + "\"},{\"input\":\"1\"}]}";
        assertThat(AiTestCaseService.parse(json, huge)).extracting(AiTestCaseService.GeneratedCase::input).containsExactly("1\n");
        assertThat(new String(json.writeValueAsBytes(cases), StandardCharsets.UTF_8)).doesNotContain("sk-fake");
    }
}
