package com.duipai.service;

import com.duipai.engine.RunEngine;
import com.duipai.storage.JsonStorage;
import com.duipai.storage.TestCaseMapper;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

/** Custom test cases are stored per problem; statement samples arrive with each run request. */
@Service
public class TestCaseService {
    static final int MAX_CASES = 50;
    private static final int MAX_STORED_FIELD_BYTES = 1024 * 1024;
    private static final int MAX_STORED_BYTES = 4 * 1024 * 1024;
    private static final int MAX_RUN_FIELD_BYTES = 2 * 1024 * 1024;
    private static final int MAX_RUN_BYTES = 16 * 1024 * 1024;
    private final ProblemService problems;
    private final TestCaseMapper mapper;
    private final JsonStorage json;
    private final RunEngine engine;

    public TestCaseService(ProblemService problems, TestCaseMapper mapper, JsonStorage json, RunEngine engine) {
        this.problems = problems; this.mapper = mapper; this.json = json; this.engine = engine;
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> list(String problemId) {
        problems.get(problemId);
        String stored = mapper.find(problemId);
        if (stored == null) return List.of();
        Object cases = json.read(stored).get("cases");
        return cases instanceof List<?> list ? (List<Map<String, Object>>) list : List.of();
    }

    public List<Map<String, Object>> save(String problemId, List<?> body) {
        problems.get(problemId);
        if (body.size() > MAX_CASES) throw new IllegalArgumentException("自定义用例最多 " + MAX_CASES + " 个");
        List<Map<String, Object>> cases = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        long total = 0;
        for (Object item : body) {
            if (!(item instanceof Map<?, ?> value)) throw new IllegalArgumentException("测试用例格式无效");
            if (!(value.get("id") instanceof String id) || id.isBlank() || id.length() > 64 || !ids.add(id)) throw new IllegalArgumentException("测试用例 ID 无效或重复");
            String input = text(value.get("input"), "输入", MAX_STORED_FIELD_BYTES);
            String expected = text(value.get("expected"), "期望输出", MAX_STORED_FIELD_BYTES);
            total += bytes(input) + bytes(expected);
            if (total > MAX_STORED_BYTES) throw new IllegalArgumentException("自定义用例总大小不能超过 4 MiB");
            LinkedHashMap<String, Object> normalized = new LinkedHashMap<>();
            normalized.put("id", id); normalized.put("input", input); normalized.put("expected", expected);
            // AI-generated cases keep their origin, so the UI can mark expected outputs as unverified.
            if (value.get("source") != null) {
                if (!"ai".equals(value.get("source"))) throw new IllegalArgumentException("测试用例来源无效");
                normalized.put("source", "ai");
            }
            String category = label(value.get("category"), "用例分类", 32), note = label(value.get("note"), "用例说明", 1000);
            if (category != null) normalized.put("category", category);
            if (note != null) normalized.put("note", note);
            total += (category == null ? 0 : bytes(category)) + (note == null ? 0 : bytes(note));
            if (total > MAX_STORED_BYTES) throw new IllegalArgumentException("自定义用例总大小不能超过 4 MiB");
            cases.add(normalized);
        }
        mapper.save(problemId, json.write(Map.of("cases", cases)), Instant.now().toString());
        return cases;
    }

    /** Runs the saved code of one solver; the client saves the problem first, as for a duipai job. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> run(Map<String, Object> body) {
        if (!(body.get("problemId") instanceof String problemId) || problemId.isBlank()) throw new IllegalArgumentException("须提供题目 ID");
        if (!(body.get("role") instanceof String role) || !List.of("brute", "optimized", "compare").contains(role)) throw new IllegalArgumentException("只能运行暴力解、优化解或对比两者");
        Object runId = body.get("runId");
        if (runId != null && (!(runId instanceof String id) || id.isBlank() || id.length() > 64)) throw new IllegalArgumentException("运行 ID 无效");
        if (!(body.get("cases") instanceof List<?> items) || items.isEmpty()) throw new IllegalArgumentException("没有可运行的测试用例");
        if (items.size() > MAX_CASES * 2) throw new IllegalArgumentException("一次最多运行 " + MAX_CASES * 2 + " 个用例");
        List<RunEngine.TestCase> cases = new ArrayList<>();
        long total = 0;
        for (Object item : items) {
            if (!(item instanceof Map<?, ?> value)) throw new IllegalArgumentException("测试用例格式无效");
            String input = text(value.get("input"), "输入", MAX_RUN_FIELD_BYTES);
            String expected = value.get("expected") == null ? null : text(value.get("expected"), "期望输出", MAX_RUN_FIELD_BYTES);
            total += bytes(input) + (expected == null ? 0 : bytes(expected));
            if (total > MAX_RUN_BYTES) throw new IllegalArgumentException("测试用例总大小不能超过 16 MiB");
            // Samples copied from a statement usually lack the final newline that line readers expect.
            if (!input.isEmpty() && !input.endsWith("\n")) input += "\n";
            cases.add(new RunEngine.TestCase(input, expected));
        }
        Map<String, Object> problem = problems.get(problemId);
        Map<String, String> codes = (Map<String, String>) problem.get("codes");
        Map<String, Object> settings = (Map<String, Object>) problem.get("settings");
        int parallelism = ((Number) settings.get("parallelism")).intValue();
        LinkedHashMap<String, Object> result;
        if (role.equals("compare")) {
            long bruteTimeout = ((Number) settings.get("bruteTimeoutMs")).longValue();
            long optimizedTimeout = ((Number) settings.get("optimizedTimeoutMs")).longValue();
            result = new LinkedHashMap<>(engine.compareTests((String) runId, codes.get("brute"), codes.get("optimized"), cases, bruteTimeout, optimizedTimeout, parallelism));
            result.put("timeoutMs", optimizedTimeout);
            result.put("bruteTimeoutMs", bruteTimeout);
        } else {
            long timeout = ((Number) settings.get(role + "TimeoutMs")).longValue();
            result = new LinkedHashMap<>(engine.runTests((String) runId, role, codes.get(role), cases, timeout, parallelism));
            result.put("timeoutMs", timeout);
        }
        result.put("problemId", problemId);
        return result;
    }

    public Map<String, Object> cancel(String runId) { return Map.of("cancelled", engine.cancelTests(runId)); }

    private static String text(Object value, String name, int maxBytes) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(name + "须为文本");
        if (bytes(text) > maxBytes) throw new IllegalArgumentException(name + "过长，单项不能超过 " + maxBytes / 1024 / 1024 + " MiB");
        return text;
    }

    private static String label(Object value, String name, int maxCharacters) {
        if (value == null) return null;
        if (!(value instanceof String text)) throw new IllegalArgumentException(name + "须为文本");
        if (text.length() > maxCharacters) throw new IllegalArgumentException(name + "过长，不能超过 " + maxCharacters + " 个字符");
        return text;
    }

    private static long bytes(String value) { return value.getBytes(StandardCharsets.UTF_8).length; }
}
