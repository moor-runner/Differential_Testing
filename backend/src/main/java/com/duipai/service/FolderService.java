package com.duipai.service;

import com.duipai.storage.FolderMapper;
import com.duipai.storage.FolderRow;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.*;

/** 题目分类（侧边栏文件夹）。分类只有一层；题目通过 ProblemService.move 归入分类。 */
@Service
public class FolderService {
    private final FolderMapper mapper;
    public FolderService(FolderMapper mapper) { this.mapper = mapper; }

    public List<Map<String, Object>> list() { return mapper.list().stream().map(FolderService::fromRow).toList(); }

    public synchronized Map<String, Object> create(Map<String, Object> body) {
        FolderRow row = new FolderRow(UUID.randomUUID().toString(), uniqueName(body.get("name"), null), false, Instant.now().toString());
        mapper.insert(row);
        return fromRow(row);
    }

    /** body 可只包含 name 或 collapsed 之一，未提供的字段保持不变。 */
    public synchronized Map<String, Object> update(String id, Map<String, Object> body) {
        FolderRow existing = require(id);
        String name = body.containsKey("name") ? uniqueName(body.get("name"), id) : existing.name();
        Object collapsed = body.getOrDefault("collapsed", existing.collapsed());
        if (!(collapsed instanceof Boolean value)) throw new IllegalArgumentException("collapsed 须为布尔值");
        FolderRow row = new FolderRow(id, name, value, existing.createdAt());
        if (mapper.update(row) == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "分类不存在");
        return fromRow(row);
    }

    /** 删除分类本身，其中的题目回到未分类。 */
    public synchronized void delete(String id) {
        require(id);
        mapper.release(id);
        if (mapper.delete(id) == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "分类不存在");
    }

    private FolderRow require(String id) {
        FolderRow row = mapper.find(id);
        if (row == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "分类不存在");
        return row;
    }

    private String uniqueName(Object value, String selfId) {
        if (!(value instanceof String text)) throw new IllegalArgumentException("分类名称须为文本");
        String name = text.strip();
        if (name.isEmpty() || name.length() > 100) throw new IllegalArgumentException("分类名称须为 1–100 个字符");
        FolderRow same = mapper.findByName(name);
        if (same != null && !same.id().equals(selfId)) throw new ResponseStatusException(HttpStatus.CONFLICT, "已有同名分类");
        return name;
    }

    private static Map<String, Object> fromRow(FolderRow row) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        result.put("id", row.id()); result.put("name", row.name()); result.put("collapsed", row.collapsed()); result.put("createdAt", row.createdAt());
        return result;
    }
}
