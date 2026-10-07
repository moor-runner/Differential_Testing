package com.duipai.service;

import com.duipai.config.DataPaths;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.server.ResponseStatusException;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.*;

class AiSettingsServiceTest {
    @TempDir Path directory;
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void exposesOnlyConfigurationStatusAndPreservesLayoutWhileEncryptingSavedKey() throws Exception {
        DataPaths paths = new DataPaths(directory.toString());
        Files.writeString(paths.settings(), "{\"layout\":{\"main\":[20,20,60]}}");
        AiSettingsService settings = new AiSettingsService(paths, json, new TestKeyProtector());
        assertThat(settings.get()).isEqualTo(new AiSettingsService.Settings("https://api.openai.com/v1", "", false));
        String key = "sk-fake-settings-encryption-test";
        AiSettingsService.Settings saved = settings.save(new AiSettingsService.Update("https://provider.example/", "my-model", key, false));
        assertThat(saved).isEqualTo(new AiSettingsService.Settings("https://provider.example/v1", "my-model", true));
        assertThat(json.writeValueAsString(saved)).doesNotContain(key, "encryptedApiKey", "\"apiKey\"");
        assertThat(directory.resolve("ai-settings.json")).content().doesNotContain(key).contains("encryptedApiKey", "test:aes:");
        assertThat(paths.settings()).hasContent("{\"layout\":{\"main\":[20,20,60]}}");
        AiSettingsService reloaded = new AiSettingsService(paths, json, new TestKeyProtector());
        assertThat(reloaded.get()).isEqualTo(saved);
        assertThat(reloaded.credentials().apiKey()).isEqualTo(key);
        assertThat(reloaded.credentials().toString()).doesNotContain(key);
        try (var files = Files.list(directory)) { assertThat(files.map(path -> path.getFileName().toString())).noneMatch(name -> name.endsWith(".tmp")); }
    }

    @Test
    void preservesOmittedOrBlankKeyAndClearsOnlyByExplicitFlagAcrossRestart() throws Exception {
        DataPaths paths = new DataPaths(directory.toString());
        AiSettingsService settings = new AiSettingsService(paths, json, new TestKeyProtector());
        settings.save(new AiSettingsService.Update(null, "model-a", "sk-fake-preserved", false));
        String originalEncryptedKey = json.readTree(Files.readString(directory.resolve("ai-settings.json"))).path("encryptedApiKey").asText();
        settings.save(new AiSettingsService.Update("https://provider.example/proxy", "model-b", null, null));
        settings.save(new AiSettingsService.Update("https://provider.example/proxy/", "model-c", "   ", false));
        assertThat(settings.credentials().apiKey()).isEqualTo("sk-fake-preserved");
        assertThat(json.readTree(Files.readString(directory.resolve("ai-settings.json"))).path("encryptedApiKey").asText()).isEqualTo(originalEncryptedKey);
        assertThat(settings.credentials().endpoint().toString()).isEqualTo("https://provider.example/proxy/chat/completions");
        settings.save(new AiSettingsService.Update(null, "model-c", null, true));
        AiSettingsService reloaded = new AiSettingsService(paths, json, new TestKeyProtector());
        assertThat(reloaded.get().apiKeyConfigured()).isFalse();
        assertThatThrownBy(reloaded::credentials).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("API Key");
        assertThatThrownBy(() -> settings.save(new AiSettingsService.Update(null, "m", "sk-fake", true)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("不能同时");
    }

    @Test
    void acceptsCompatibleProviderPathsAndRejectsUnsafeOrInvalidAddresses() {
        assertThat(AiSettingsService.endpoint("https://example.com").toString()).isEqualTo("https://example.com/v1/chat/completions");
        assertThat(AiSettingsService.endpoint("http://127.0.0.1:8181/v1///").toString()).isEqualTo("http://127.0.0.1:8181/v1/chat/completions");
        assertThat(AiSettingsService.endpoint("https://example.com/custom/proxy/").toString()).isEqualTo("https://example.com/custom/proxy/chat/completions");
        assertThat(AiSettingsService.endpoint("https://example.com/custom/chat/completions/").toString()).isEqualTo("https://example.com/custom/chat/completions");
        assertThat(AiSettingsService.endpoint("http://[::1]:8181").toString()).isEqualTo("http://[::1]:8181/v1/chat/completions");
        for (String invalid : List.of("file:///tmp/api", "https://user:password@example.com/v1", "https://example.com/v1?api_key=secret",
                "https://example.com/v1#fragment", "example.com/v1", "http://example.com:0/v1", "http://example.com:65536/v1", "https://example.com/a b"))
            assertThatThrownBy(() -> AiSettingsService.endpoint(invalid)).isInstanceOf(IllegalArgumentException.class)
                    .hasMessageNotContaining("password").hasMessageNotContaining("secret");
    }

    @Test
    void validatesSettingsBeforeWritingAndReportsMissingModelWithoutDecryptingKey() throws Exception {
        AiSettingsService settings = new AiSettingsService(new DataPaths(directory.toString()), json, new TestKeyProtector());
        assertThatThrownBy(() -> settings.save(null)).isInstanceOf(IllegalArgumentException.class);
        for (AiSettingsService.Update invalid : List.of(new AiSettingsService.Update("x".repeat(2049), "m", null, false),
                new AiSettingsService.Update(null, "x".repeat(201), null, false),
                new AiSettingsService.Update(null, "model\nname", null, false),
                new AiSettingsService.Update(null, "m", "fake key", false),
                new AiSettingsService.Update(null, "m", "x".repeat(8193), false),
                new AiSettingsService.Update(null, "m", "fake\nkey", false)))
            assertThatThrownBy(() -> settings.save(invalid)).isInstanceOf(IllegalArgumentException.class);
        assertThat(directory.resolve("ai-settings.json")).doesNotExist();
        settings.save(new AiSettingsService.Update(null, "", "sk-fake-no-model", false));
        assertThatThrownBy(settings::credentials).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("模型名称");
    }

    @Test
    void doesNotReplaceSavedConfigurationIfEncryptionFailsAndRejectsOversizedFiles() throws Exception {
        DataPaths paths = new DataPaths(directory.toString());
        AiSettingsService settings = new AiSettingsService(paths, json, new TestKeyProtector());
        settings.save(new AiSettingsService.Update(null, "m", "sk-fake-original", false));
        String previous = Files.readString(directory.resolve("ai-settings.json"));
        AiSettingsService broken = new AiSettingsService(paths, json, new AiKeyProtector() {
            @Override public String protect(String key) { throw new IllegalStateException("Encryption unavailable"); }
            @Override public String unprotect(String encrypted) { throw new IllegalStateException("Encryption unavailable"); }
        });
        assertThatThrownBy(() -> broken.save(new AiSettingsService.Update(null, "other-model", "sk-fake-new", false))).isInstanceOf(IllegalStateException.class);
        assertThat(directory.resolve("ai-settings.json")).hasContent(previous);
        Files.writeString(directory.resolve("ai-settings.json"), "x".repeat(65537));
        assertThatThrownBy(settings::get).isInstanceOf(ResponseStatusException.class).hasMessageContaining("设置文件损坏");
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    void encryptsAndDecryptsUsingTheCurrentWindowsAccountWithoutPlaintextStorage() throws Exception {
        WindowsAiKeyProtector protector = new WindowsAiKeyProtector();
        String key = "sk-fake-real-dpapi-round-trip";
        String encrypted = protector.protect(key);
        assertThat(encrypted).startsWith("dpapi:v1:").doesNotContain(key);
        assertThat(protector.unprotect(encrypted)).isEqualTo(key);
        assertThat(protector.protect(key)).isNotEqualTo(encrypted);
        assertThatThrownBy(() -> protector.unprotect("dpapi:v1:invalid-base64"))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("重新填写密钥");
        DataPaths paths = new DataPaths(directory.toString());
        AiSettingsService settings = new AiSettingsService(paths, json);
        settings.save(new AiSettingsService.Update(null, "test-model", key, false));
        assertThat(directory.resolve("ai-settings.json")).content().doesNotContain(key).contains("dpapi:v1:");
        assertThat(new AiSettingsService(paths, json).credentials().apiKey()).isEqualTo(key);
    }

    /** Injected authenticated encryption keeps portable tests independent of the operating system. */
    static final class TestKeyProtector implements AiKeyProtector {
        private static final SecretKeySpec KEY = new SecretKeySpec("test-key-16bytes".getBytes(StandardCharsets.UTF_8), "AES");
        @Override public String protect(String value) {
            try {
                byte[] nonce = new byte[12]; new SecureRandom().nextBytes(nonce);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, KEY, new GCMParameterSpec(128, nonce));
                byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
                byte[] result = new byte[nonce.length + ciphertext.length];
                System.arraycopy(nonce, 0, result, 0, nonce.length);
                System.arraycopy(ciphertext, 0, result, nonce.length, ciphertext.length);
                return "test:aes:" + Base64.getEncoder().encodeToString(result);
            } catch (Exception error) { throw new IllegalStateException("Test encryption failed", error); }
        }
        @Override public String unprotect(String value) {
            try {
                byte[] result = Base64.getDecoder().decode(value.substring("test:aes:".length()));
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, KEY, new GCMParameterSpec(128, result, 0, 12));
                return new String(cipher.doFinal(result, 12, result.length - 12), StandardCharsets.UTF_8);
            } catch (Exception error) { throw new IllegalStateException("Test decryption failed", error); }
        }
    }
}
