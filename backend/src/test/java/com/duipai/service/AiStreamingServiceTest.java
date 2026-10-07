package com.duipai.service;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.duipai.config.DataPaths;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.*;

class AiStreamingServiceTest {
    @TempDir Path directory;
    private final ObjectMapper json = new ObjectMapper();
    private HttpServer server;
    private ExecutorService threads;
    private AiStatementService service;
    private AiSettingsService settings;
    private AiRequestTracker tracker;
    private final AtomicReference<Responder> responder = new AtomicReference<>();
    private final AtomicInteger calls = new AtomicInteger();

    @BeforeEach
    void startProvider() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        threads = Executors.newVirtualThreadPerTaskExecutor(); server.setExecutor(threads);
        responder.set(exchange -> stream(exchange, delta("# 完整题面", null, "stop") + "data: [DONE]\n\n", 128));
        server.createContext("/", exchange -> {
            calls.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            try { responder.get().respond(exchange); }
            catch (IOException ignored) { /* Streaming cancellation deliberately closes this socket. */ }
            finally { exchange.close(); }
        });
        server.start();
        settings = new AiSettingsService(new DataPaths(directory.toString()), json, new AiSettingsServiceTest.TestKeyProtector());
        settings.save(new AiSettingsService.Update("http://127.0.0.1:" + server.getAddress().getPort() + "/v1", "mock-model", "sk-fake-stream-only", false));
        tracker = new AiRequestTracker();
        service = service(Duration.ofSeconds(4));
    }

    @AfterEach
    void closeProvider() { server.stop(0); threads.close(); }

    @Test
    void disablesThinkingOnlyForTheOfficialDeepSeekHostWithoutAnyLiveProviderCall() {
        Map<String, Object> deepseek = AiStatementService.providerBody(URI.create("https://api.deepseek.com/v1/chat/completions"), "deepseek-flash", "system", "user");
        assertThat(deepseek).containsEntry("stream", true).containsEntry("thinking", Map.of("type", "disabled"));
        for (String endpoint : List.of("https://api.openai.com/v1/chat/completions", "http://127.0.0.1:9000/v1/chat/completions",
                "https://api.deepseek.com.evil.example/v1/chat/completions", "https://proxy.example/deepseek/chat/completions"))
            assertThat(AiStatementService.providerBody(URI.create(endpoint), "compatible-model", "system", "user"))
                    .containsEntry("stream", true).doesNotContainKeys("thinking", "temperature", "max_tokens", "max_completion_tokens");
    }

    @Test
    void streamsChineseAcrossBytePacketsAndCountsReasoningWithoutExposingItInResultsOrLogs() throws Exception {
        String id = UUID.randomUUID().toString();
        String source = "PRIVATE SOURCE TEXT 1000000";
        String thought = "PRIVATE REASONING 数据校对";
        String expected = "# 中文题面\n\n```text\n9\n```";
        responder.set(exchange -> stream(exchange, "\uFEFF: 心跳\r\n\r\n" + delta(null, thought, null)
                + delta("# 中文", null, null) + ": keep-alive\n\n" + delta("题面\n\n```text\n9\n```", null, "stop") + "data: [DONE]\n\n", 2));
        Logger logger = (Logger) LoggerFactory.getLogger(AiRequestTracker.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>(); appender.start(); logger.addAppender(appender);
        try {
            assertThat(service.organize(source, id).statement()).isEqualTo(expected);
            AiRequestTracker.Snapshot snapshot = service.request(id);
            assertThat(snapshot.state()).isEqualTo("SUCCEEDED");
            assertThat(snapshot.stage()).isEqualTo("completed");
            assertThat(snapshot.httpStatus()).isEqualTo(200);
            assertThat(snapshot.firstResponseMs()).isNotNull().isBetween(0L, snapshot.elapsedMs());
            assertThat(snapshot.receivedCharacters()).isEqualTo(expected.length());
            assertThat(snapshot.reasoningCharacters()).isEqualTo(thought.length());
            assertThat(snapshot.thinkingDisabled()).isFalse();
            assertThat(json.writeValueAsString(snapshot)).doesNotContain(source, thought, expected, "sk-fake-stream-only");
            String logs = String.join("\n", appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList());
            assertThat(logs).contains(id, "httpStatus=200", "stage=generating", "stage=completed", "elapsedMs=", "reasoningCharacters=")
                    .doesNotContain(source, thought, expected, "sk-fake-stream-only");
            assertThat(calls).hasValue(1);
        } finally { logger.detachAppender(appender); appender.stop(); }
    }

    @Test
    void exposesWaitingReasoningAndGeneratingProgressWhileTheOriginalPostIsStillRunning() throws Exception {
        String id = UUID.randomUUID().toString();
        CountDownLatch startThinking = new CountDownLatch(1), startContent = new CountDownLatch(1), complete = new CountDownLatch(1);
        responder.set(exchange -> {
            headers(exchange);
            write(exchange, ": keep-alive\n\n");
            await(startThinking); write(exchange, delta(null, "校对数字", null));
            await(startContent); write(exchange, delta("# 整理题面", null, null));
            await(complete); write(exchange, delta(null, null, "stop") + "data: [DONE]\n\n");
        });
        try (ExecutorService tasks = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> result = tasks.submit(() -> service.organize("原文", id));
            try {
                AiRequestTracker.Snapshot waiting = poll(id, snapshot -> Integer.valueOf(200).equals(snapshot.httpStatus()));
                assertThat(waiting.state()).isEqualTo("RUNNING"); assertThat(waiting.stage()).isEqualTo("waiting");
                assertThat(waiting.firstResponseMs()).isNull();
                startThinking.countDown();
                AiRequestTracker.Snapshot thinking = poll(id, snapshot -> snapshot.reasoningCharacters() == 4);
                assertThat(thinking.stage()).isEqualTo("reasoning"); assertThat(thinking.firstResponseMs()).isNotNull();
                startContent.countDown();
                AiRequestTracker.Snapshot generating = poll(id, snapshot -> snapshot.receivedCharacters() == 6);
                assertThat(generating.stage()).isEqualTo("generating"); assertThat(result.isDone()).isFalse();
                complete.countDown(); result.get(2, TimeUnit.SECONDS);
                AiRequestTracker.Snapshot done = service.request(id);
                Thread.sleep(20);
                assertThat(service.request(id).elapsedMs()).isEqualTo(done.elapsedMs());
                assertThat(service.request(id).state()).isEqualTo("SUCCEEDED");
            } finally { startThinking.countDown(); startContent.countDown(); complete.countDown(); }
        }
    }

    @Test
    void rejectsIncompleteFilteredAbortedErrorAndTruncatedStreamsWithoutReturningPartialOutput() throws Exception {
        for (String stream : List.of(delta("# 部分题面", null, "stop"),
                delta("# 部分题面", null, null) + "data: [DON",
                delta("# 部分题面", null, "length") + "data: [DONE]\n\n",
                delta("# 部分题面", null, "content_filter") + "data: [DONE]\n\n",
                delta("# 部分题面", null, "aborted") + "data: [DONE]\n\n",
                "data: {\"error\":\"PRIVATE PROVIDER BODY sk-fake-stream-only\"}\n\n",
                "event: error\ndata: PRIVATE PROVIDER BODY sk-fake-stream-only\n\n",
                "data: [DONE]\n\n")) {
            String id = UUID.randomUUID().toString();
            responder.set(exchange -> stream(exchange, stream, 32));
            assertThatThrownBy(() -> service.organize("PRIVATE SOURCE", id)).isInstanceOfSatisfying(ResponseStatusException.class,
                    error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY));
            AiRequestTracker.Snapshot snapshot = service.request(id);
            assertThat(snapshot.state()).isEqualTo("FAILED");
            assertThat(json.writeValueAsString(snapshot)).doesNotContain("部分题面", "PRIVATE PROVIDER BODY", "PRIVATE SOURCE", "sk-fake-stream-only");
        }
    }

    @Test
    void returnsAnAuthenticationFailureImmediatelyAfterHeadersWithoutWaitingForTheErrorBody() throws Exception {
        CountDownLatch hold = new CountDownLatch(1), upstreamClosed = new CountDownLatch(1);
        AtomicBoolean disconnected = new AtomicBoolean();
        responder.set(exchange -> {
            exchange.sendResponseHeaders(401, 0); exchange.getResponseBody().flush();
            try {
                await(hold);
                for (int attempt = 0; attempt < 100; attempt++) { write(exchange, "PRIVATE PROVIDER BODY"); Thread.sleep(10); }
            } catch (IOException error) { disconnected.set(true); throw error; }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            finally { upstreamClosed.countDown(); }
        });
        String id = UUID.randomUUID().toString(); long started = System.nanoTime();
        try {
            assertThatThrownBy(() -> service.test(id)).isInstanceOfSatisfying(ResponseStatusException.class, error -> {
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY); assertThat(error.getReason()).contains("认证");
            });
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(1));
            assertThat(service.request(id).httpStatus()).isEqualTo(401);
            assertThat(service.request(id).state()).isEqualTo("FAILED");
            hold.countDown();
            assertThat(upstreamClosed.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(disconnected).isTrue();
        } finally { hold.countDown(); }
    }

    @Test
    void cancelsTheUpstreamImmediatelyAllowsRetryAndNeverPublishesTheOldPartialResult() throws Exception {
        String first = UUID.randomUUID().toString(), second = UUID.randomUUID().toString();
        CountDownLatch released = new CountDownLatch(1), upstreamClosed = new CountDownLatch(1);
        AtomicBoolean disconnected = new AtomicBoolean();
        responder.set(exchange -> {
            headers(exchange); write(exchange, delta("# 不完整旧结果", null, null));
            try {
                await(released);
                for (int attempt = 0; attempt < 50; attempt++) { write(exchange, ": heartbeats\n\n"); Thread.sleep(10); }
                write(exchange, delta("旧请求迟到的文本", null, "stop") + "data: [DONE]\n\n");
            } catch (IOException error) { disconnected.set(true); throw error; }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            finally { upstreamClosed.countDown(); }
        });
        try (ExecutorService tasks = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> old = tasks.submit(() -> service.organize("原文", first));
            try {
                poll(first, snapshot -> snapshot.receivedCharacters() > 0);
                assertThat(service.cancel(first).state()).isEqualTo("CANCELLED");
                responder.set(exchange -> stream(exchange, delta("# 重试完整结果", null, "stop") + "data: [DONE]\n\n", 128));
                assertThat(service.organize("原文", second).statement()).isEqualTo("# 重试完整结果");
                assertThatThrownBy(() -> old.get(1, TimeUnit.SECONDS)).hasCauseInstanceOf(ResponseStatusException.class);
                released.countDown(); assertThat(upstreamClosed.await(2, TimeUnit.SECONDS)).isTrue();
                assertThat(disconnected).isTrue();
                AiRequestTracker.Snapshot cancelled = service.request(first);
                assertThat(cancelled.state()).isEqualTo("CANCELLED");
                assertThat(cancelled.logs()).noneSatisfy(log -> assertThat(log.message()).contains("请求完成"));
                assertThat(service.request(second).state()).isEqualTo("SUCCEEDED");
                assertThat(service.cancel(first)).isEqualTo(cancelled);
            } finally { released.countDown(); }
        }
    }

    @Test
    void supportsJsonFallbackWithoutRepeatingTheRequestAndRejectsDuplicateOrInvalidRequestIds() throws Exception {
        responder.set(exchange -> {
            byte[] response = "{\"choices\":[{\"message\":{\"content\":\"# 完整JSON题面\",\"reasoning_content\":\"隐藏推理\"},\"finish_reason\":\"stop\"}]}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(200, response.length); exchange.getResponseBody().write(response);
        });
        String id = UUID.randomUUID().toString();
        assertThat(service.organize("原文", id).statement()).isEqualTo("# 完整JSON题面");
        assertThat(service.request(id).reasoningCharacters()).isEqualTo(4);
        assertThat(service.request(id).firstResponseMs()).isNotNull();
        assertThat(calls).hasValue(1);
        assertThatThrownBy(() -> service.organize("原文", id)).isInstanceOfSatisfying(ResponseStatusException.class,
                error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThatThrownBy(() -> service.organize("原文", "not-an-id sk-fake-key")).isInstanceOf(IllegalArgumentException.class).hasMessageNotContaining("sk-fake-key");
        assertThatThrownBy(() -> service.request(UUID.randomUUID().toString())).isInstanceOfSatisfying(ResponseStatusException.class,
                error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThat(calls).hasValue(1);
    }

    @Test
    void acceptsJsonFallbackEvenIfACompatibleProviderLeavesAnEventStreamContentType() throws Exception {
        responder.set(exchange -> {
            headers(exchange);
            write(exchange, "{\"choices\":[{\"message\":{\"content\":\"# JSON兼容结果\"},\"finish_reason\":\"stop\"}]}");
        });
        String id = UUID.randomUUID().toString();
        assertThat(service.organize("原文", id).statement()).isEqualTo("# JSON兼容结果");
        assertThat(service.request(id).state()).isEqualTo("SUCCEEDED");
        assertThat(calls).hasValue(1);
    }

    @Test
    void enforcesStreamingBodyAndTextBoundsAndTheTotalDeadlineDespiteHeartbeats() throws Exception {
        for (String excessive : List.of(": " + "x".repeat(2 * 1024 * 1024) + "\n\n", delta("x".repeat(100001), null, "stop") + "data: [DONE]\n\n")) {
            String id = UUID.randomUUID().toString(); responder.set(exchange -> stream(exchange, excessive, 8192));
            assertThatThrownBy(() -> service.organize("原文", id)).isInstanceOfSatisfying(ResponseStatusException.class,
                    error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY));
            assertThat(service.request(id).state()).isEqualTo("FAILED");
        }
        responder.set(exchange -> {
            headers(exchange);
            try { for (int attempt = 0; attempt < 30; attempt++) { write(exchange, ": heartbeat\n\n"); Thread.sleep(30); } }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        });
        AiStatementService shortDeadline = service(Duration.ofMillis(200)); String id = UUID.randomUUID().toString();
        assertThatThrownBy(() -> shortDeadline.organize("原文", id)).isInstanceOfSatisfying(ResponseStatusException.class,
                error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.GATEWAY_TIMEOUT));
        assertThat(shortDeadline.request(id).state()).isEqualTo("FAILED");
        assertThat(shortDeadline.request(id).firstResponseMs()).isNull();
    }

    private AiStatementService service(Duration timeout) {
        return new AiStatementService(settings, json, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1))
                .followRedirects(HttpClient.Redirect.NEVER).build(), timeout, tracker);
    }
    private AiRequestTracker.Snapshot poll(String id, Predicate<AiRequestTracker.Snapshot> ready) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < until) {
            try { AiRequestTracker.Snapshot snapshot = service.request(id); if (ready.test(snapshot)) return snapshot; }
            catch (ResponseStatusException ignored) { }
            Thread.sleep(5);
        }
        throw new AssertionError("Timed out waiting for safe request metadata");
    }
    private String delta(String content, String reasoning, String finish) throws IOException {
        Map<String, Object> delta = new java.util.LinkedHashMap<>();
        if (content != null) delta.put("content", content); if (reasoning != null) delta.put("reasoning_content", reasoning);
        Map<String, Object> choice = new java.util.LinkedHashMap<>(); choice.put("delta", delta); choice.put("finish_reason", finish);
        return "data: " + json.writeValueAsString(Map.of("choices", List.of(choice))) + "\n\n";
    }
    private static void headers(HttpExchange exchange) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8"); exchange.sendResponseHeaders(200, 0);
    }
    private static void write(HttpExchange exchange, String text) throws IOException {
        exchange.getResponseBody().write(text.getBytes(StandardCharsets.UTF_8)); exchange.getResponseBody().flush();
    }
    private static void stream(HttpExchange exchange, String text, int packetSize) throws IOException {
        headers(exchange); byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        for (int index = 0; index < bytes.length; index += packetSize) {
            exchange.getResponseBody().write(bytes, index, Math.min(packetSize, bytes.length - index)); exchange.getResponseBody().flush();
        }
    }
    private static void await(CountDownLatch latch) throws IOException {
        try { if (!latch.await(3, TimeUnit.SECONDS)) throw new IOException("Fixture wait timed out"); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
    }
    @FunctionalInterface private interface Responder { void respond(HttpExchange exchange) throws IOException; }
}
