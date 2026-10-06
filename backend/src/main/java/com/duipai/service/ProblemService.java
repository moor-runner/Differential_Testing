package com.duipai.service;

import com.duipai.storage.JsonStorage;
import com.duipai.storage.ProblemMapper;
import com.duipai.storage.ProblemRow;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

@Service
public class ProblemService {
    private final ProblemMapper mapper;
    private final JsonStorage json;
    public ProblemService(ProblemMapper mapper, JsonStorage json) { this.mapper = mapper; this.json = json; }

    public List<Map<String, Object>> list() {
        return mapper.list().stream().map(row -> Map.<String, Object>of("id", row.id(), "title", row.title(), "updatedAt", row.updatedAt())).toList();
    }

    public Map<String, Object> create(Map<String, Object> body) {
        String title = title(body.get("title"));
        ProblemRow row = new ProblemRow(UUID.randomUUID().toString(), title, Templates.STATEMENT, json.write(Templates.codes()), json.write(defaultSettings()), Instant.now().toString());
        mapper.insert(row);
        return fromRow(row);
    }

    public Map<String, Object> get(String id) { return fromRow(require(id)); }

    public Map<String, Object> update(String id, Map<String, Object> body) {
        require(id);
        String title = title(body.get("title"));
        String statement = text(body.get("statement"), "题面", 2 * 1024 * 1024);
        Map<String, String> codes = normalizeCodes(body.get("codes"));
        Map<String, Object> settings = normalizeSettings(body.get("settings"));
        ProblemRow row = new ProblemRow(id, title, statement, json.write(codes), json.write(settings), Instant.now().toString());
        if (mapper.update(row) == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "题目不存在");
        return fromRow(row);
    }

    public void delete(String id) {
        if (mapper.delete(id) == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "题目不存在");
    }

    private ProblemRow require(String id) {
        ProblemRow row = mapper.find(id);
        if (row == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "题目不存在");
        return row;
    }

    private Map<String, Object> fromRow(ProblemRow row) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        result.put("id", row.id()); result.put("title", row.title()); result.put("statement", row.statement());
        result.put("codes", json.read(row.codesJson())); result.put("settings", json.read(row.settingsJson())); result.put("updatedAt", row.updatedAt());
        return result;
    }

    private String title(Object value) {
        String title = text(value, "题目名称", 800).strip();
        if (title.isEmpty() || title.length() > 200) throw new IllegalArgumentException("题目名称须为 1–200 个字符");
        return title;
    }

    private String text(Object value, String name, int maxBytes) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(name + "须为文本");
        if (text.getBytes(StandardCharsets.UTF_8).length > maxBytes) throw new IllegalArgumentException(name + "过长");
        return text;
    }

    private Map<String, String> normalizeCodes(Object value) {
        if (!(value instanceof Map<?, ?> values)) throw new IllegalArgumentException("须提供生成器、暴力解和优化解代码");
        LinkedHashMap<String, String> codes = new LinkedHashMap<>();
        for (String role : List.of("generator", "brute", "optimized")) codes.put(role, text(values.get(role), role + "代码", 1024 * 1024));
        return codes;
    }

    public static Map<String, Object> defaultSettings() {
        LinkedHashMap<String, Object> settings = new LinkedHashMap<>();
        settings.put("rounds", 1000); settings.put("startSeed", null); settings.put("parallelism", 4);
        settings.put("generatorTimeoutMs", 5000); settings.put("bruteTimeoutMs", 10000); settings.put("optimizedTimeoutMs", 2000);
        return settings;
    }

    public static Map<String, Object> normalizeSettings(Object value) {
        if (!(value instanceof Map<?, ?> values)) throw new IllegalArgumentException("须提供运行参数");
        LinkedHashMap<String, Object> settings = new LinkedHashMap<>(defaultSettings());
        settings.put("rounds", integer(values.getOrDefault("rounds", null), 1000, 1, 1_000_000, "轮数"));
        settings.put("parallelism", integer(values.get("parallelism"), 4, 1, 32, "并行度"));
        settings.put("generatorTimeoutMs", integer(values.get("generatorTimeoutMs"), 5000, 1, 600_000, "生成器时限"));
        settings.put("bruteTimeoutMs", integer(values.get("bruteTimeoutMs"), 10000, 1, 600_000, "暴力解时限"));
        settings.put("optimizedTimeoutMs", integer(values.get("optimizedTimeoutMs"), 2000, 1, 600_000, "优化解时限"));
        Object seedValue = values.get("startSeed");
        if (seedValue != null && !(seedValue instanceof String)) throw new IllegalArgumentException("种子须为十进制字符串，不能使用 JSON 数值");
        String seed = seedValue == null ? null : ((String) seedValue).strip();
        if (seed != null && seed.isEmpty()) seed = null;
        if (seed != null) {
            try {
                long start = Long.parseLong(seed);
                Math.addExact(start, ((Number) settings.get("rounds")).longValue() - 1);
                seed = Long.toString(start);
            } catch (NumberFormatException | ArithmeticException exception) { throw new IllegalArgumentException("种子或末轮种子超出有符号 64 位整数范围"); }
        }
        settings.put("startSeed", seed);
        return settings;
    }

    private static int integer(Object value, int fallback, int min, int max, String name) {
        if (value == null) return fallback;
        if (!(value instanceof Number number) || number.doubleValue() != number.longValue() || number.longValue() < min || number.longValue() > max)
            throw new IllegalArgumentException(name + "须为 " + min + "–" + max + " 的整数");
        return number.intValue();
    }
}
