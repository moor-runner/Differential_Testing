package com.duipai.storage;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class JsonStorage {
    private final ObjectMapper mapper;
    public JsonStorage(ObjectMapper mapper) { this.mapper = mapper; }
    public String write(Object value) {
        try { return mapper.writeValueAsString(value); }
        catch (IOException exception) { throw new IllegalStateException("无法序列化本地数据", exception); }
    }
    public Map<String, Object> read(String value) {
        try { return mapper.readValue(value, new TypeReference<LinkedHashMap<String, Object>>() { }); }
        catch (IOException exception) { throw new IllegalStateException("本地数据文件损坏", exception); }
    }
}
