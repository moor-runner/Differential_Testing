package com.duipai.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Contains only safe request metadata; source text, generated text and credentials never enter this tracker. */
@Service
public class AiRequestTracker {
    private static final Logger LOG = LoggerFactory.getLogger(AiRequestTracker.class);
    private static final long TTL_NANOS = Duration.ofMinutes(30).toNanos();
    private static final int MAX_REQUESTS = 128;
    private static final int MAX_LOGS = 50;
    private final Map<String, Entry> requests = new LinkedHashMap<>();

    synchronized Entry start(String operation, String requestedId) {
        cleanup();
        String id = validateId(requestedId == null ? UUID.randomUUID().toString() : requestedId);
        if (requests.containsKey(id)) throw new ResponseStatusException(HttpStatus.CONFLICT, "请求 ID 已使用，请重新发起请求");
        while (requests.size() >= MAX_REQUESTS) {
            Iterator<Map.Entry<String, Entry>> iterator = requests.entrySet().iterator();
            boolean removed = false;
            while (iterator.hasNext()) {
                if (!iterator.next().getValue().running()) { iterator.remove(); removed = true; break; }
            }
            if (!removed) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "AI 请求记录已满，请稍后再试");
        }
        Entry entry = new Entry(id, operation);
        requests.put(id, entry);
        return entry;
    }

    public synchronized Snapshot get(String requestedId) {
        cleanup();
        return find(requestedId).snapshot();
    }

    public Snapshot cancel(String requestedId) {
        Entry entry;
        synchronized (this) { cleanup(); entry = find(requestedId); }
        entry.cancel();
        return entry.snapshot();
    }

    private Entry find(String requestedId) {
        Entry entry = requests.get(validateId(requestedId));
        if (entry == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "AI 请求记录不存在或已过期");
        return entry;
    }

    private void cleanup() {
        long now = System.nanoTime();
        requests.values().removeIf(entry -> !entry.running() && now - entry.finishedAt() > TTL_NANOS);
    }

    private static String validateId(String id) {
        if (id == null || !id.matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}"))
            throw new IllegalArgumentException("请求 ID 必须是 UUID");
        return UUID.fromString(id).toString();
    }

    public record LogEntry(long elapsedMs, String level, String message) { }
    public record Snapshot(String id, String operation, String state, String stage, String message, long elapsedMs,
                           Long firstResponseMs, int receivedCharacters, int reasoningCharacters, Integer httpStatus,
                           boolean thinkingDisabled, List<LogEntry> logs) { }

    static final class Entry {
        private final String id;
        private final String operation;
        private final long started = System.nanoTime();
        private final List<LogEntry> logs = new ArrayList<>();
        private String state = "RUNNING";
        private String stage = "connecting";
        private String message = "正在连接 AI 服务…";
        private long finished;
        private Long firstResponseMs;
        private Integer httpStatus;
        private int receivedCharacters;
        private int reasoningCharacters;
        private boolean thinkingDisabled;
        private long lastProgressLog;
        private Runnable cancellation;

        private Entry(String id, String operation) {
            this.id = id;
            this.operation = operation;
            log("info", "开始请求，正在连接 AI 服务");
        }

        synchronized boolean running() { return state.equals("RUNNING"); }
        synchronized boolean cancelled() { return state.equals("CANCELLED"); }
        synchronized long finishedAt() { return finished; }
        synchronized long remainingNanos(Duration deadline) { return deadline.toNanos() - (System.nanoTime() - started); }

        void attachCancellation(Runnable action) {
            boolean cancelNow;
            synchronized (this) { cancellation = action; cancelNow = cancelled(); }
            if (cancelNow) action.run();
        }

        synchronized void policy(boolean disabled) {
            if (!running()) return;
            thinkingDisabled = disabled;
            if (disabled) log("info", "已关闭 DeepSeek 思考模式，直接生成整理题面");
        }

        synchronized void headers(int status) {
            if (!running()) return;
            httpStatus = status;
            stage = "waiting";
            message = "AI 服务已连接，正在等待生成内容…";
            log("info", "已收到服务响应头，HTTP " + status);
        }

        synchronized void firstResponse() {
            if (!running() || firstResponseMs != null) return;
            firstResponseMs = elapsed();
            log("info", "已收到 AI 首次正文响应");
        }

        synchronized void progress(int contentCharacters, int thoughtCharacters) {
            if (!running()) return;
            receivedCharacters = contentCharacters;
            reasoningCharacters = thoughtCharacters;
            String nextStage = contentCharacters > 0 ? "generating" : thoughtCharacters > 0 ? "reasoning" : "waiting";
            boolean changed = !stage.equals(nextStage);
            stage = nextStage;
            message = stage.equals("generating") ? "正在生成整理题面，已收到 " + contentCharacters + " 个字符…"
                    : stage.equals("reasoning") ? "AI 正在处理内容，已收到 " + thoughtCharacters + " 个推理字符…"
                    : "AI 服务已连接，正在等待生成内容…";
            if (changed || elapsed() - lastProgressLog >= 5000) {
                log("info", message);
                lastProgressLog = elapsed();
            }
        }

        synchronized void validating() {
            if (!running() || stage.equals("validating")) return;
            stage = "validating";
            message = "AI 已生成完成，正在校验题面格式…";
            log("info", "完整响应已收到，正在校验结果");
        }

        synchronized boolean succeed() {
            if (!running()) return false;
            state = "SUCCEEDED";
            stage = "completed";
            message = "AI 整理已完成，可校对后应用。";
            finished = System.nanoTime();
            log("info", "请求完成");
            cancellation = null;
            return true;
        }

        synchronized void fail(String safeMessage) {
            if (!running()) return;
            state = "FAILED";
            stage = "failed";
            message = safeMessage;
            finished = System.nanoTime();
            log("error", safeMessage);
            cancellation = null;
        }

        void cancel() {
            Runnable action;
            synchronized (this) {
                if (!running()) return;
                state = "CANCELLED";
                stage = "cancelled";
                message = "已取消 AI 请求，题面未修改。";
                finished = System.nanoTime();
                log("info", "用户取消请求，正在关闭上游连接");
                action = cancellation;
                cancellation = null;
            }
            if (action != null) action.run();
        }

        synchronized Snapshot snapshot() {
            return new Snapshot(id, operation, state, stage, message, elapsed(), firstResponseMs,
                    receivedCharacters, reasoningCharacters, httpStatus, thinkingDisabled, List.copyOf(logs));
        }

        private long elapsed() { return Duration.ofNanos((finished == 0 ? System.nanoTime() : finished) - started).toMillis(); }
        private void log(String level, String safeMessage) {
            LogEntry event = new LogEntry(elapsed(), level, safeMessage);
            if (logs.size() >= MAX_LOGS) logs.remove(1);
            logs.add(event);
            String format = "AI request={} operation={} stage={} elapsedMs={} httpStatus={} receivedCharacters={} reasoningCharacters={} message={}";
            Object[] values = {id, operation, stage, event.elapsedMs(), httpStatus, receivedCharacters, reasoningCharacters, safeMessage};
            if (level.equals("error")) LOG.warn(format, values); else LOG.info(format, values);
        }
    }
}
