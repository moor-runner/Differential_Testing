package com.duipai.service;

import com.duipai.engine.DebugEngine;
import com.duipai.engine.DebugSession;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * Debugs one test case of a problem's saved brute or optimized code. Clients follow a session over SSE: {@code state}
 * events carry full snapshots (with a version to order them), {@code output} events carry console text from the
 * offset that subscriber has already received, so every subscription starts with the whole console.
 */
@Service
public class DebugService implements DebugSession.Listener {
    private static final int MAX_TEXT_BYTES = 2 * 1024 * 1024, MAX_LABEL = 64, MAX_SUBSCRIBERS = 8;
    /** A session nobody follows or touches for this long is stopped, e.g. after the window reloaded mid-debug. */
    private static final long ABANDONED_NANOS = TimeUnit.MINUTES.toNanos(5);
    private final DebugEngine engine;
    private final ProblemService problems;
    private final ExecutorService sender = Executors.newSingleThreadExecutor(Thread.ofPlatform().daemon(true).name("duipai-debug-sse").factory());
    private final ScheduledExecutorService ticker = Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon(true).name("duipai-debug-tick").factory());
    private final List<Subscriber> subscribers = new CopyOnWriteArrayList<>();
    private final Map<String, String> problemIds = new ConcurrentHashMap<>();
    private final AtomicBoolean statePending = new AtomicBoolean(), outputPending = new AtomicBoolean();
    private volatile long lastActivity = System.nanoTime();

    private static final class Subscriber {
        final String sessionId;
        final SseEmitter emitter;
        int sent;
        long version = -1;
        Subscriber(String sessionId, SseEmitter emitter) { this.sessionId = sessionId; this.emitter = emitter; }
    }

    public DebugService(DebugEngine engine, ProblemService problems) { this.engine = engine; this.problems = problems; }

    @PostConstruct
    public void initialize() {
        ticker.scheduleWithFixedDelay(() -> { if (outputPending.getAndSet(false)) sender.execute(this::broadcastOutput); }, 60, 60, TimeUnit.MILLISECONDS);
        ticker.scheduleWithFixedDelay(this::stopAbandoned, 30, 30, TimeUnit.SECONDS);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> start(Map<String, Object> body) {
        if (!(body.get("problemId") instanceof String problemId) || problemId.isBlank()) throw new IllegalArgumentException("须提供题目 ID");
        if (!(body.get("role") instanceof String role) || !List.of("brute", "optimized").contains(role)) throw new IllegalArgumentException("只能调试暴力解或优化解");
        String input = text(body.get("input"), "输入");
        String expected = body.get("expected") == null ? null : text(body.get("expected"), "期望输出");
        Object rawLabel = body.get("label");
        if (rawLabel != null && (!(rawLabel instanceof String value) || value.length() > MAX_LABEL)) throw new IllegalArgumentException("用例名称须为不超过 " + MAX_LABEL + " 个字符的文本");
        List<Integer> breakpoints = BreakpointService.lines(body.get("breakpoints"));
        Map<String, String> codes = (Map<String, String>) problems.get(problemId).get("codes");
        String code = codes.get(role);
        if (code == null || code.isBlank()) throw new IllegalArgumentException("代码不能为空");
        // Samples copied from a statement usually lack the final newline that line readers expect, as for test runs.
        if (!input.isEmpty() && !input.endsWith("\n")) input += "\n";
        DebugSession session = engine.start(new DebugSession.Request(role, rawLabel == null ? "" : (String) rawLabel, code, input, expected, breakpoints), this);
        problemIds.clear();
        problemIds.put(session.id(), problemId);
        lastActivity = System.nanoTime();
        return enrich(session.snapshot(), session);
    }

    public Map<String, Object> snapshot(String id) { DebugSession session = session(id); return enrich(session.snapshot(), session); }
    public Map<String, Object> resume(String id) { DebugSession session = session(id); return enrich(command(session::resume), session); }
    public Map<String, Object> pause(String id) { DebugSession session = session(id); return enrich(command(session::pause), session); }

    public Map<String, Object> step(String id, Map<String, Object> body) {
        DebugSession session = session(id);
        DebugSession.Step kind = switch (String.valueOf(body.get("kind"))) {
            case "over" -> DebugSession.Step.OVER;
            case "into" -> DebugSession.Step.INTO;
            case "out" -> DebugSession.Step.OUT;
            default -> throw new IllegalArgumentException("单步方式须为 over、into 或 out");
        };
        return enrich(command(() -> session.step(kind)), session);
    }

    public Map<String, Object> runToLine(String id, Map<String, Object> body) {
        DebugSession session = session(id);
        if (!(body.get("line") instanceof Integer line) || line < 1) throw new IllegalArgumentException("行号须为正整数");
        return enrich(command(() -> session.runToLine(line)), session);
    }

    public Map<String, Object> stop(String id) {
        DebugSession session = session(id);
        session.stop();
        return enrich(session.snapshot(), session);
    }

    public Map<String, Object> breakpoints(String id, Map<String, Object> body) {
        DebugSession session = session(id);
        List<Integer> lines = BreakpointService.lines(body.get("lines"));
        return Map.of("breakpoints", command(() -> session.setBreakpoints(lines)));
    }

    public Map<String, Object> frameVariables(String id, int generation, int index) {
        DebugSession session = session(id);
        return Map.of("variables", command(() -> session.frameVariables(generation, index)));
    }

    public Map<String, Object> children(String id, int generation, int reference, int start, int count) {
        DebugSession session = session(id);
        return command(() -> session.children(generation, reference, start, count));
    }

    public Map<String, Object> console(String id, int from) { return session(id).console(from); }

    /** Stops the session of a problem that is being deleted. */
    public void stopForProblem(String problemId) {
        DebugSession current = engine.current();
        if (current != null && problemId.equals(problemIds.get(current.id()))) current.stop();
    }

    public SseEmitter subscribe(String id) {
        DebugSession session = session(id);
        if (subscribers.stream().filter(subscriber -> subscriber.sessionId.equals(id)).count() >= MAX_SUBSCRIBERS)
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "调试连接数过多");
        SseEmitter emitter = new SseEmitter(0L);
        Subscriber subscriber = new Subscriber(id, emitter);
        subscribers.add(subscriber);
        Runnable cleanup = () -> subscribers.remove(subscriber);
        emitter.onCompletion(cleanup);
        emitter.onTimeout(cleanup);
        emitter.onError(error -> cleanup.run());
        sender.execute(() -> send(subscriber, session, true));
        return emitter;
    }

    // ---- listener: called by the session with its monitor held, so only schedule here ----

    @Override public void changed(DebugSession session) {
        if (statePending.compareAndSet(false, true)) sender.execute(() -> { statePending.set(false); broadcast(); });
    }

    @Override public void output(DebugSession session) { outputPending.set(true); }

    private void broadcast() {
        for (Subscriber subscriber : subscribers) {
            DebugSession session = engine.find(subscriber.sessionId);
            // A session replaced by a newer one is no longer followed.
            if (session == null) finish(subscriber);
            else send(subscriber, session, true);
        }
    }

    private void broadcastOutput() {
        for (Subscriber subscriber : subscribers) {
            DebugSession session = engine.find(subscriber.sessionId);
            if (session != null) send(subscriber, session, false);
        }
    }

    /** Console first, so a terminated state never arrives before the output that preceded it. */
    private void send(Subscriber subscriber, DebugSession session, boolean state) {
        try {
            synchronized (subscriber) {
                if (session.consoleLength() > subscriber.sent) {
                    Map<String, Object> delta = session.console(subscriber.sent);
                    subscriber.emitter.send(SseEmitter.event().name("output").data(delta));
                    subscriber.sent = (Integer) delta.get("length");
                }
                if (!state) return;
                Map<String, Object> snapshot = enrich(session.snapshot(), session);
                long version = ((Number) snapshot.get("version")).longValue();
                if (version != subscriber.version) {
                    subscriber.emitter.send(SseEmitter.event().name("state").data(snapshot));
                    subscriber.version = version;
                }
                if ("TERMINATED".equals(snapshot.get("state"))) finish(subscriber);
            }
        } catch (IOException | IllegalStateException closed) { finish(subscriber); }
    }

    private void finish(Subscriber subscriber) {
        subscribers.remove(subscriber);
        try { subscriber.emitter.complete(); } catch (IllegalStateException ignored) { /* already completed */ }
    }

    private void stopAbandoned() {
        DebugSession current = engine.current();
        if (current == null || current.isTerminated()) return;
        if (subscribers.stream().anyMatch(subscriber -> subscriber.sessionId.equals(current.id()))) { lastActivity = System.nanoTime(); return; }
        if (System.nanoTime() - lastActivity > ABANDONED_NANOS) current.stop();
    }

    private DebugSession session(String id) {
        DebugSession session = engine.find(id);
        if (session == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "调试会话不存在或已被新的调试取代");
        lastActivity = System.nanoTime();
        return session;
    }

    /** Commands race with the program: one that finds it in another state, or gone, is a conflict to retry, not a server error. */
    private static <T> T command(Supplier<T> action) {
        try { return action.get(); }
        catch (IllegalArgumentException invalid) { throw invalid; }
        catch (IllegalStateException conflict) { throw new ResponseStatusException(HttpStatus.CONFLICT, conflict.getMessage()); }
        catch (RuntimeException failure) {
            if (failure.getClass().getName().startsWith("com.sun.jdi.")) throw new ResponseStatusException(HttpStatus.CONFLICT, "程序状态已变化，请重试");
            throw failure;
        }
    }

    private Map<String, Object> enrich(Map<String, Object> snapshot, DebugSession session) {
        Map<String, Object> copy = new LinkedHashMap<>(snapshot);
        copy.put("problemId", problemIds.get(session.id()));
        return copy;
    }

    private static String text(Object value, String name) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(name + "须为文本");
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_TEXT_BYTES) throw new IllegalArgumentException(name + "过长，不能超过 2 MiB");
        return text;
    }

    @PreDestroy
    public void close() {
        ticker.shutdownNow();
        sender.shutdownNow();
        subscribers.forEach(subscriber -> { try { subscriber.emitter.complete(); } catch (IllegalStateException ignored) { } });
        subscribers.clear();
    }
}
