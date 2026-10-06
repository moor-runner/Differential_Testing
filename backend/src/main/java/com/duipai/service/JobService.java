package com.duipai.service;

import com.duipai.engine.RunEngine;
import com.duipai.storage.JsonStorage;
import com.duipai.storage.RunMapper;
import com.duipai.storage.RunRow;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

@Service
public class JobService {
    private static final Logger LOG = LoggerFactory.getLogger(JobService.class);
    private final RunEngine engine;
    private final ProblemService problems;
    private final RunMapper runs;
    private final JsonStorage json;
    private final ScheduledExecutorService progress = Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon(true).name("duipai-sse").factory());
    private final Map<String, CopyOnWriteArrayList<SseEmitter>> subscribers = new ConcurrentHashMap<>();
    private volatile Map<String, Object> current;
    private volatile String activeProblemId;

    public JobService(RunEngine engine, ProblemService problems, RunMapper runs, JsonStorage json) {
        this.engine = engine; this.problems = problems; this.runs = runs; this.json = json;
    }

    @PostConstruct
    public void initialize() {
        for (RunRow row : runs.unfinished()) {
            Map<String, Object> snapshot = json.read(row.snapshotJson());
            snapshot.put("state", "FINISHED"); snapshot.put("verdict", "INTERNAL_ERROR"); snapshot.put("message", "应用关闭前任务未完成，请重新运行");
            runs.save(new RunRow(row.id(), row.problemId(), json.write(snapshot), row.createdAt()));
        }
        progress.scheduleAtFixedRate(() -> {
            Map<String, Object> latest = current;
            if (latest != null) publish(liveSnapshot(latest));
        }, 300, 300, TimeUnit.MILLISECONDS);
    }

    @SuppressWarnings("unchecked")
    public synchronized Map<String, Object> start(String problemId, String replaySeed) {
        if (current != null || engine.isBusy()) throw new ResponseStatusException(HttpStatus.CONFLICT, "已有对拍任务运行中");
        Map<String, Object> problem = problems.get(problemId);
        if (replaySeed != null) {
            try { replaySeed = Long.toString(Long.parseLong(replaySeed.strip())); }
            catch (NumberFormatException exception) { throw new IllegalArgumentException("复现种子须为有符号 64 位整数"); }
        }
        String id = UUID.randomUUID().toString();
        activeProblemId = problemId;
        try {
            Map<String, Object> initial = enrich(engine.start(id, (Map<String, String>) problem.get("codes"), (Map<String, Object>) problem.get("settings"), replaySeed, value -> accept(problemId, value)), problemId);
            current = initial;
            persist(initial);
            return initial;
        } catch (RuntimeException exception) {
            activeProblemId = null;
            current = null;
            throw exception;
        }
    }

    private synchronized void accept(String problemId, Map<String, Object> value) {
        Map<String, Object> snapshot = enrich(value, problemId);
        if ("FINISHED".equals(snapshot.get("state"))) {
            try { persist(snapshot); }
            catch (RuntimeException exception) {
                LOG.error("Failed to save run {}", snapshot.get("id"), exception);
                snapshot.put("message", String.valueOf(snapshot.getOrDefault("message", "")) + "（运行记录保存失败，请检查磁盘）");
            }
            current = snapshot;
            publish(snapshot);
            activeProblemId = null;
            current = null;
        } else current = snapshot;
    }

    private Map<String, Object> enrich(Map<String, Object> value, String problemId) {
        LinkedHashMap<String, Object> copy = new LinkedHashMap<>(value);
        copy.put("problemId", problemId);
        return copy;
    }

    private void persist(Map<String, Object> snapshot) {
        runs.save(new RunRow(String.valueOf(snapshot.get("id")), String.valueOf(snapshot.get("problemId")), json.write(snapshot), String.valueOf(snapshot.getOrDefault("startedAt", Instant.now().toString()))));
    }

    public Map<String, Object> snapshot(String id) {
        Map<String, Object> latest = current;
        if (latest != null && id.equals(latest.get("id"))) return liveSnapshot(latest);
        RunRow row = runs.find(id);
        if (row == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "运行记录不存在");
        return json.read(row.snapshotJson());
    }

    private Map<String, Object> liveSnapshot(Map<String, Object> cached) {
        Map<String, Object> dynamic = engine.snapshot(String.valueOf(cached.get("id")));
        // Finished snapshots become visible after their durable write in accept().
        if (dynamic != null && !"FINISHED".equals(dynamic.get("state"))) return enrich(dynamic, String.valueOf(cached.get("problemId")));
        return new LinkedHashMap<>(cached);
    }

    public List<Map<String, Object>> history(String problemId) {
        problems.get(problemId);
        return runs.list(problemId).stream().map(row -> json.read(row.snapshotJson())).toList();
    }

    public Map<String, Object> cancel(String id) {
        Map<String, Object> snapshot = snapshot(id);
        if (!"FINISHED".equals(snapshot.get("state"))) engine.cancel(id);
        return snapshot(id);
    }

    public boolean ownsActiveJob(String problemId) { return problemId.equals(activeProblemId); }

    public synchronized void deleteProblem(String problemId) {
        if (ownsActiveJob(problemId)) throw new ResponseStatusException(HttpStatus.CONFLICT, "请先停止此题目的运行任务");
        problems.delete(problemId);
    }

    public SseEmitter subscribe(String id) {
        Map<String, Object> snapshot = snapshot(id);
        SseEmitter emitter = new SseEmitter(0L);
        CopyOnWriteArrayList<SseEmitter> list = subscribers.computeIfAbsent(id, key -> new CopyOnWriteArrayList<>());
        if (list.size() >= 8) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "任务连接数过多");
        list.add(emitter);
        Runnable cleanup = () -> { list.remove(emitter); if (list.isEmpty()) subscribers.remove(id, list); };
        emitter.onCompletion(cleanup); emitter.onTimeout(cleanup); emitter.onError(error -> cleanup.run());
        send(emitter, snapshot, list);
        // Close the race where the final callback ran between the initial read and subscription.
        if (!"FINISHED".equals(snapshot.get("state"))) {
            Map<String, Object> latest = snapshot(id);
            if ("FINISHED".equals(latest.get("state"))) send(emitter, latest, list);
        }
        return emitter;
    }

    private void publish(Map<String, Object> snapshot) {
        String id = String.valueOf(snapshot.get("id"));
        CopyOnWriteArrayList<SseEmitter> list = subscribers.get(id);
        if (list == null) return;
        for (SseEmitter emitter : list) send(emitter, snapshot, list);
        if (list.isEmpty()) subscribers.remove(id, list);
    }

    private void send(SseEmitter emitter, Map<String, Object> snapshot, CopyOnWriteArrayList<SseEmitter> list) {
        try {
            synchronized (emitter) {
                emitter.send(SseEmitter.event().name("progress").data(snapshot));
                if ("FINISHED".equals(snapshot.get("state"))) { list.remove(emitter); emitter.complete(); }
            }
        } catch (IOException | IllegalStateException exception) { list.remove(emitter); emitter.complete(); }
    }

    public String export(String id, String kind) {
        Map<String, Object> snapshot = snapshot(id);
        if ("input".equals(kind)) return snapshot.get("input") == null ? "" : String.valueOf(snapshot.get("input"));
        String role = kind.endsWith("-stderr") ? kind.substring(0, kind.length() - 7) : kind;
        if (!List.of("generator", "brute", "optimized").contains(role)) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "导出类型不存在");
        Object value = snapshot.get(role);
        if (!(value instanceof Map<?, ?> result)) return "";
        Object text = result.get(kind.endsWith("-stderr") ? "stderr" : "stdout");
        return text == null ? "" : String.valueOf(text);
    }

    @PreDestroy
    public void close() {
        engine.close();
        progress.shutdownNow();
        subscribers.values().forEach(list -> list.forEach(SseEmitter::complete));
        subscribers.clear();
    }
}
