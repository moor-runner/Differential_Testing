package com.duipai.service;

import com.duipai.storage.BreakpointMapper;
import com.duipai.storage.JsonStorage;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

/** Breakpoint lines of a problem's three programs, kept apart from the problem so toggling one never touches its autosave. */
@Service
public class BreakpointService {
    static final List<String> ROLES = List.of("generator", "brute", "optimized");
    static final int MAX_LINES = 1000, MAX_LINE = 1_000_000;
    private final ProblemService problems;
    private final BreakpointMapper mapper;
    private final JsonStorage json;

    public BreakpointService(ProblemService problems, BreakpointMapper mapper, JsonStorage json) {
        this.problems = problems; this.mapper = mapper; this.json = json;
    }

    public Map<String, Object> get(String problemId) {
        problems.get(problemId);
        String stored = mapper.find(problemId);
        Map<String, Object> saved = stored == null ? Map.of() : json.read(stored);
        Map<String, Object> result = new LinkedHashMap<>();
        // Stored data was validated on save; anything unreadable is dropped rather than failing the editor.
        for (String role : ROLES) {
            try { result.put(role, lines(saved.get(role))); }
            catch (IllegalArgumentException invalid) { result.put(role, List.of()); }
        }
        return result;
    }

    public Map<String, Object> save(String problemId, Map<String, Object> body) {
        problems.get(problemId);
        Map<String, Object> result = new LinkedHashMap<>();
        for (String role : ROLES) result.put(role, lines(body.get(role)));
        mapper.save(problemId, json.write(result), Instant.now().toString());
        return result;
    }

    /** Sorted, distinct 1-based line numbers; a missing list means none. */
    public static List<Integer> lines(Object value) {
        if (value == null) return List.of();
        if (!(value instanceof List<?> items)) throw new IllegalArgumentException("断点须为行号列表");
        if (items.size() > MAX_LINES) throw new IllegalArgumentException("断点最多 " + MAX_LINES + " 个");
        TreeSet<Integer> lines = new TreeSet<>();
        for (Object item : items) {
            if (!(item instanceof Number number) || number.doubleValue() != number.longValue() || number.longValue() < 1 || number.longValue() > MAX_LINE)
                throw new IllegalArgumentException("断点行号须为 1–" + MAX_LINE + " 的整数");
            lines.add(number.intValue());
        }
        return List.copyOf(lines);
    }
}
