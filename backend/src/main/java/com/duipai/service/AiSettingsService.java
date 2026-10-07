package com.duipai.service;

import com.duipai.config.DataPaths;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

@Service
public class AiSettingsService {
    public static final String DEFAULT_BASE_URL = "https://api.openai.com/v1";
    private static final int MAX_SETTINGS_BYTES = 64 * 1024;
    private final Path settingsFile;
    private final ObjectMapper json;
    private final AiKeyProtector protector;

    @Autowired
    public AiSettingsService(DataPaths paths, ObjectMapper json) {
        this(paths, json, new WindowsAiKeyProtector());
    }

    AiSettingsService(DataPaths paths, ObjectMapper json, AiKeyProtector protector) {
        this.settingsFile = paths.root().resolve("ai-settings.json");
        this.json = json;
        this.protector = protector;
    }

    public synchronized Settings get() {
        Saved saved = read();
        return publicSettings(saved);
    }

    public synchronized Settings save(Update update) {
        if (update == null) throw new IllegalArgumentException("请提供 AI 设置");
        String baseUrl = normalizeBaseUrl(update.baseUrl());
        String model = validateModel(update.model());
        String providedKey = update.apiKey();
        if (providedKey != null && !providedKey.isBlank()) validateKey(providedKey.trim());
        if (Boolean.TRUE.equals(update.clearApiKey()) && providedKey != null && !providedKey.isBlank())
            throw new IllegalArgumentException("清除 API Key 和设置新密钥不能同时进行");
        Saved previous = read();
        String encryptedKey = previous.encryptedApiKey();
        if (Boolean.TRUE.equals(update.clearApiKey())) encryptedKey = null;
        else if (providedKey != null && !providedKey.isBlank()) encryptedKey = protector.protect(providedKey.trim());
        Saved saved = new Saved(baseUrl, model, encryptedKey);
        Path temporary = null;
        try {
            byte[] content = json.writeValueAsBytes(saved);
            if (content.length > MAX_SETTINGS_BYTES) throw new IllegalArgumentException("AI 设置过大");
            temporary = Files.createTempFile(settingsFile.getParent(), "ai-settings-", ".tmp");
            Files.write(temporary, content);
            try { Files.move(temporary, settingsFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
            catch (AtomicMoveNotSupportedException error) { Files.move(temporary, settingsFile, StandardCopyOption.REPLACE_EXISTING); }
            return publicSettings(saved);
        } catch (IOException error) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "无法保存 AI 设置，请检查数据目录权限或磁盘空间");
        } finally {
            if (temporary != null) try { Files.deleteIfExists(temporary); } catch (IOException ignored) { }
        }
    }

    synchronized Credentials credentials() {
        Saved saved = read();
        if (saved.model().isBlank()) throw new IllegalArgumentException("请先在 AI 设置中填写模型名称");
        if (saved.encryptedApiKey() == null || saved.encryptedApiKey().isBlank())
            throw new IllegalArgumentException("请先在 AI 设置中填写 API Key");
        String key = protector.unprotect(saved.encryptedApiKey());
        validateKey(key);
        return new Credentials(endpoint(saved.baseUrl()), saved.model(), key);
    }

    private Saved read() {
        if (!Files.exists(settingsFile)) return new Saved(DEFAULT_BASE_URL, "", null);
        try {
            if (Files.size(settingsFile) > MAX_SETTINGS_BYTES) throw new IOException("Too large");
            Saved saved = json.readValue(Files.readString(settingsFile, StandardCharsets.UTF_8), Saved.class);
            if (saved == null || (saved.encryptedApiKey() != null && saved.encryptedApiKey().length() > 48 * 1024))
                throw new IOException("Invalid settings");
            return new Saved(normalizeBaseUrl(saved.baseUrl()), validateModel(saved.model()), saved.encryptedApiKey());
        } catch (IOException | IllegalArgumentException error) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "AI 设置文件损坏，请检查 ai-settings.json 或恢复备份");
        }
    }

    private Settings publicSettings(Saved saved) {
        return new Settings(saved.baseUrl(), saved.model(), saved.encryptedApiKey() != null && !saved.encryptedApiKey().isBlank());
    }

    static String normalizeBaseUrl(String value) {
        String text = value == null || value.isBlank() ? DEFAULT_BASE_URL : value.trim();
        if (text.length() > 2048) throw new IllegalArgumentException("API 地址过长（最多 2048 个字符）");
        try {
            URI uri = new URI(text);
            if (!uri.isAbsolute() || uri.getScheme() == null
                    || !(uri.getScheme().equalsIgnoreCase("http") || uri.getScheme().equalsIgnoreCase("https"))
                    || uri.getHost() == null || uri.getHost().isBlank() || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getPort() == 0 || uri.getPort() > 65535)
                throw new URISyntaxException("", "Invalid API address");
            String path = uri.getRawPath() == null ? "" : uri.getRawPath();
            while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
            if (path.isEmpty()) path = "/v1";
            return uri.getScheme().toLowerCase(java.util.Locale.ROOT) + "://" + uri.getRawAuthority() + path;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("API 地址必须是 HTTP 或 HTTPS 地址，且不能含用户名、密码、查询参数或锚点");
        }
    }

    static URI endpoint(String baseUrl) {
        String normalized = normalizeBaseUrl(baseUrl);
        return URI.create(normalized.endsWith("/chat/completions") ? normalized : normalized + "/chat/completions");
    }

    private static String validateModel(String value) {
        String model = value == null ? "" : value.trim();
        if (model.length() > 200 || model.codePoints().anyMatch(Character::isISOControl))
            throw new IllegalArgumentException("模型名称无效（最多 200 个字符，不含控制字符）");
        return model;
    }

    private static void validateKey(String value) {
        if (value == null || value.isBlank() || value.length() > 8192
                || value.chars().anyMatch(character -> character < 33 || character > 126))
            throw new IllegalArgumentException("API Key 无效（最多 8192 个字符，不含空格或控制字符）");
    }

    public record Settings(String baseUrl, String model, boolean apiKeyConfigured) { }
    public record Update(String baseUrl, String model, String apiKey, Boolean clearApiKey) { }
    private record Saved(String baseUrl, String model, String encryptedApiKey) { }
    record Credentials(URI endpoint, String model, String apiKey) {
        @Override public String toString() { return "AI credentials for " + model; }
    }
}
