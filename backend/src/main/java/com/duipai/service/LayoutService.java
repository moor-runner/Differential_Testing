package com.duipai.service;

import com.duipai.config.DataPaths;
import com.duipai.storage.JsonStorage;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.LinkedHashMap;
import java.util.Map;

@Service
public class LayoutService {
    private final DataPaths paths;
    private final JsonStorage json;
    public LayoutService(DataPaths paths, JsonStorage json) { this.paths = paths; this.json = json; }

    public synchronized Map<String, Object> get() throws IOException {
        if (!Files.exists(paths.settings())) return Map.of();
        Map<String, Object> settings = json.read(Files.readString(paths.settings()));
        Object layout = settings.get("layout");
        if (!(layout instanceof Map<?, ?> map)) return Map.of();
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        map.forEach((key, value) -> result.put(String.valueOf(key), value));
        return result;
    }

    public synchronized Map<String, Object> save(Map<String, Object> layout) throws IOException {
        String encoded = json.write(layout);
        if (encoded.getBytes(StandardCharsets.UTF_8).length > 64 * 1024) throw new IllegalArgumentException("布局设置过大");
        Map<String, Object> settings = Files.exists(paths.settings()) ? json.read(Files.readString(paths.settings())) : new LinkedHashMap<>();
        settings.put("layout", layout);
        Path temp = Files.createTempFile(paths.root(), "settings-", ".tmp");
        try {
            Files.writeString(temp, json.write(settings), StandardCharsets.UTF_8);
            try { Files.move(temp, paths.settings(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
            catch (AtomicMoveNotSupportedException exception) { Files.move(temp, paths.settings(), StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(temp); }
        return json.read(encoded);
    }
}
