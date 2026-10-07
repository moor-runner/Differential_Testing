package com.duipai.service;

import com.duipai.config.DataPaths;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.*;

class AiStatementServiceTest {
    @TempDir Path directory;
    private final ObjectMapper json = new ObjectMapper();
    private HttpServer server;
    private ExecutorService serverThreads;
    private AiSettingsService settings;
    private AiStatementService service;
    private final AtomicReference<JsonNode> request = new AtomicReference<>();
    private final AtomicReference<String> authorization = new AtomicReference<>();
    private final AtomicReference<String> requestPath = new AtomicReference<>();
    private final AtomicInteger requests = new AtomicInteger();
    private final AtomicReference<Responder> responder = new AtomicReference<>();

    @BeforeEach
    void startProvider() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        serverThreads = Executors.newVirtualThreadPerTaskExecutor();
        server.setExecutor(serverThreads);
        responder.set(exchange -> respond(exchange, 200, completion("# 整理后的题面\n\n输入 n，1 <= n <= 1000000。", "stop")));
        server.createContext("/", exchange -> {
            requests.incrementAndGet();
            authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            requestPath.set(exchange.getRequestURI().getPath());
            try {
                request.set(json.readTree(exchange.getRequestBody()));
                responder.get().respond(exchange);
            } catch (IOException ignored) { /* Client cancellation is expected in timeout and size tests. */ }
            finally { exchange.close(); }
        });
        server.start();
        settings = new AiSettingsService(new DataPaths(directory.toString()), json, new AiSettingsServiceTest.TestKeyProtector());
        settings.save(new AiSettingsService.Update(address() + "/proxy/v1/", "provider-model", "sk-fake-http-test", false));
        service = service(Duration.ofSeconds(5));
    }

    @AfterEach
    void stopProvider() {
        if (server != null) server.stop(0);
        if (serverThreads != null) serverThreads.close();
    }

    @Test
    void sendsTheSavedModelAndKeyUsingOnlyCompatibleChatCompletionsFields() throws Exception {
        String original = "输入 n，1 <= n <= 1000000\n样例输入：9\n样例输出：6\n重复水印与考试界面";
        AiStatementService.OrganizedStatement result = service.organize(original);
        assertThat(result.statement()).contains("1000000");
        assertThat(authorization.get()).isEqualTo("Bearer sk-fake-http-test");
        assertThat(requestPath.get()).isEqualTo("/proxy/v1/chat/completions");
        List<String> fields = new ArrayList<>(); request.get().fieldNames().forEachRemaining(fields::add);
        assertThat(fields).containsExactlyInAnyOrder("model", "messages", "stream");
        assertThat(request.get().path("model").asText()).isEqualTo("provider-model");
        assertThat(request.get().path("stream").asBoolean()).isTrue();
        assertThat(request.get().path("messages")).hasSize(2);
        assertThat(request.get().path("messages").path(0).path("role").asText()).isEqualTo("system");
        assertThat(request.get().path("messages").path(0).path("content").asText())
                .contains("【待确认】", "不得推断或编造", "不要解题", "输入输出值", "text 代码块");
        assertThat(request.get().path("messages").path(1).path("role").asText()).isEqualTo("user");
        assertThat(request.get().path("messages").path(1).path("content").asText()).isEqualTo(original);
        assertThat(json.writeValueAsString(result)).doesNotContain("sk-fake-http-test");
    }

    @Test
    void testsConnectionWithATinyRequestAndUsesAnExplicitCompletionAddress() throws Exception {
        settings.save(new AiSettingsService.Update(address() + "/custom/chat/completions/", "other-model", null, false));
        AiStatementService.ConnectionResult result = service.test();
        assertThat(result.message()).isEqualTo("连接成功");
        assertThat(result.model()).isEqualTo("other-model");
        assertThat(requestPath.get()).isEqualTo("/custom/chat/completions");
        assertThat(request.get().path("messages").path(1).path("content").asText()).isEqualTo("请只回复：连接成功");
        assertThat(request.get().path("messages").path(0).path("content").asText()).doesNotContain("题面");
        assertThat(json.writeValueAsString(result)).doesNotContain("sk-fake-http-test");
    }

    @Test
    void validatesInputAndMissingConfigurationWithoutAnyProviderCall() throws Exception {
        for (String invalid : new String[]{null, "", " \n ", "x".repeat(100001)})
            assertThatThrownBy(() -> service.organize(invalid)).isInstanceOf(IllegalArgumentException.class);
        settings.save(new AiSettingsService.Update(address(), "", null, false));
        assertThatThrownBy(service::test).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("模型名称");
        settings.save(new AiSettingsService.Update(address(), "model", null, true));
        assertThatThrownBy(() -> service.organize("题面")).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("API Key");
        assertThat(requests).hasValue(0);
    }

    @Test
    void turnsProviderErrorsIntoSafeActionableMessagesWithoutEchoingBodies() throws Exception {
        for (int status : new int[]{400, 401, 403, 404, 422, 429, 500}) {
            responder.set(exchange -> respond(exchange, status, "{\"error\":\"provider echoed sk-fake-http-test and PRIVATE BODY\"}"));
            assertThatThrownBy(() -> service.organize("待整理题面"))
                    .isInstanceOfSatisfying(ResponseStatusException.class, error -> {
                        assertThat(error.getStatusCode()).isEqualTo(status == 429 ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.BAD_GATEWAY);
                        assertThat(error.getReason()).doesNotContain("sk-fake-http-test", "PRIVATE BODY");
                    });
        }
        responder.set(exchange -> respond(exchange, 200, "{\"error\":\"PRIVATE BODY\"}"));
        assertThatThrownBy(() -> service.organize("题面")).isInstanceOf(ResponseStatusException.class).hasMessageNotContaining("PRIVATE BODY");
    }

    @Test
    void neverFollowsRedirectsOrForwardsTheSecretToAnotherEndpoint() {
        AtomicInteger redirected = new AtomicInteger();
        server.createContext("/redirected", exchange -> { redirected.incrementAndGet(); respond(exchange, 200, completion("泄漏", "stop")); });
        responder.set(exchange -> {
            exchange.getResponseHeaders().set("Location", address() + "/redirected");
            respond(exchange, 307, "redirect with sk-fake-http-test");
        });
        assertThatThrownBy(service::test).isInstanceOfSatisfying(ResponseStatusException.class, error -> {
            assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
            assertThat(error.getReason()).contains("重定向").doesNotContain("sk-fake-http-test");
        });
        assertThat(redirected).hasValue(0);
        assertThat(requests).hasValue(1);
    }

    @Test
    void rejectsEmptyMalformedRefusedAndTruncatedCompletionsWithoutReturningPartialText() throws Exception {
        for (String body : List.of("not JSON sk-fake-http-test", "null", "{}", "{\"choices\":[]}",
                completion("", "stop"), completion("\n  ", "stop"), completion("部分题面", "length"),
                completion("被过滤", "content_filter"),
                "{\"choices\":[{\"message\":{\"content\":\"text\",\"refusal\":\"PRIVATE BODY\"},\"finish_reason\":\"stop\"}]}",
                completion("x".repeat(100001), "stop"))) {
            responder.set(exchange -> respond(exchange, 200, body));
            assertThatThrownBy(() -> service.organize("题面")).isInstanceOfSatisfying(ResponseStatusException.class, error -> {
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
                assertThat(error.getReason()).doesNotContain("sk-fake-http-test", "PRIVATE BODY", "部分题面");
            });
        }
    }

    @Test
    void acceptsCompatibleTextBlocksAndRemovesOnlyTheWholeDocumentWrapper() throws Exception {
        String markdown = "# 标题\n\n## 样例\n\n```text\n9\n```";
        responder.set(exchange -> respond(exchange, 200, completion("```markdown\n" + markdown + "\n```", "stop")));
        assertThat(service.organize("题面").statement()).isEqualTo(markdown);
        responder.set(exchange -> respond(exchange, 200, "{\"choices\":[{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"# 标题\"},{\"type\":\"text\",\"text\":\"\\n描述\"}]},\"finish_reason\":\"stop\"}]}"));
        assertThat(service.organize("题面").statement()).isEqualTo("# 标题\n描述");
    }

    @Test
    void boundsProviderResponseSizeAndCanMakeAnotherRequestAfterFailure() throws Exception {
        responder.set(exchange -> respond(exchange, 200, "x".repeat(2 * 1024 * 1024 + 1)));
        assertThatThrownBy(() -> service.organize("题面")).isInstanceOfSatisfying(ResponseStatusException.class, error -> {
            assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
            assertThat(error.getReason()).contains("内容过大");
        });
        responder.set(exchange -> respond(exchange, 200, completion("# 成功", "stop")));
        assertThat(service.organize("题面").statement()).isEqualTo("# 成功");
    }

    @Test
    void enforcesATotalTimeoutIncludingResponseBodyAndReleasesTheRequestSlot() throws Exception {
        AiStatementService shortTimeout = service(Duration.ofMillis(300));
        responder.set(exchange -> {
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write("{".getBytes(StandardCharsets.UTF_8)); exchange.getResponseBody().flush();
            try { Thread.sleep(600); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            exchange.getResponseBody().write("}".getBytes(StandardCharsets.UTF_8));
        });
        long started = System.nanoTime();
        assertThatThrownBy(() -> shortTimeout.organize("题面")).isInstanceOfSatisfying(ResponseStatusException.class,
                error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.GATEWAY_TIMEOUT));
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(2));
        responder.set(exchange -> respond(exchange, 200, completion("# 可继续整理", "stop")));
        assertThat(shortTimeout.organize("题面").statement()).isEqualTo("# 可继续整理");
    }

    @Test
    void rejectsConcurrentAiRequestsAndRecoversAfterTheCurrentRequestCompletes() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        responder.set(exchange -> {
            entered.countDown();
            try { if (!release.await(3, TimeUnit.SECONDS)) throw new IOException("Test timeout"); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
            respond(exchange, 200, completion("# 一次整理", "stop"));
        });
        try (ExecutorService tasks = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> active = tasks.submit(() -> service.organize("题面"));
            try {
                assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(service::test).isInstanceOfSatisfying(ResponseStatusException.class,
                        error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS));
            } finally { release.countDown(); }
            active.get(3, TimeUnit.SECONDS);
        }
        assertThat(service.test().message()).isEqualTo("连接成功");
    }

    private AiStatementService service(Duration timeout) {
        return new AiStatementService(settings, json, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1))
                .followRedirects(HttpClient.Redirect.NEVER).build(), timeout);
    }

    private String address() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
    private String completion(String content, String finishReason) throws IOException {
        return json.writeValueAsString(java.util.Map.of("choices", List.of(java.util.Map.of("message", java.util.Map.of("content", content), "finish_reason", finishReason))));
    }
    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }
    @FunctionalInterface private interface Responder { void respond(HttpExchange exchange) throws IOException; }
}
