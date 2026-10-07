package com.duipai.service;

import com.sun.jna.Memory;
import com.sun.jna.Native;
import com.sun.jna.Platform;
import com.sun.jna.Pointer;
import com.sun.jna.Structure;
import com.sun.jna.WString;
import com.sun.jna.win32.StdCallLibrary;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

/** Windows DPAPI protects a saved key for the current Windows account. */
final class WindowsAiKeyProtector implements AiKeyProtector {
    private static final int UI_FORBIDDEN = 1;
    private static final String PREFIX = "dpapi:v1:";

    @Override public String protect(String apiKey) {
        byte[] plaintext = apiKey.getBytes(StandardCharsets.UTF_8);
        try { return PREFIX + Base64.getEncoder().encodeToString(transform(plaintext, true)); }
        finally { Arrays.fill(plaintext, (byte) 0); }
    }

    @Override public String unprotect(String encryptedApiKey) {
        if (!encryptedApiKey.startsWith(PREFIX)) throw unavailable(false);
        byte[] plaintext;
        try { plaintext = transform(Base64.getDecoder().decode(encryptedApiKey.substring(PREFIX.length())), false); }
        catch (IllegalArgumentException error) { throw unavailable(false); }
        try { return new String(plaintext, StandardCharsets.UTF_8); }
        finally { Arrays.fill(plaintext, (byte) 0); }
    }

    private byte[] transform(byte[] source, boolean encrypt) {
        if (!Platform.isWindows()) throw unavailable(encrypt);
        DataBlob output = new DataBlob();
        try (Memory inputMemory = new Memory(Math.max(1, source.length))) {
            inputMemory.write(0, source, 0, source.length);
            DataBlob input = new DataBlob();
            input.cbData = source.length;
            input.pbData = inputMemory;
            boolean success;
            try {
                success = encrypt
                        ? Crypt32.INSTANCE.CryptProtectData(input, null, null, null, null, UI_FORBIDDEN, output)
                        : Crypt32.INSTANCE.CryptUnprotectData(input, null, null, null, null, UI_FORBIDDEN, output);
            } catch (LinkageError error) { throw unavailable(encrypt); }
            finally { inputMemory.clear(); }
            if (!success || output.pbData == null || output.cbData <= 0 || output.cbData > 64 * 1024)
                throw unavailable(encrypt);
            return output.pbData.getByteArray(0, output.cbData);
        } finally {
            if (output.pbData != null) {
                if (output.cbData > 0 && output.cbData <= 64 * 1024) output.pbData.clear(output.cbData);
                Kernel32.INSTANCE.LocalFree(output.pbData);
            }
        }
    }

    private ResponseStatusException unavailable(boolean encrypt) {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, encrypt
                ? "无法使用 Windows 账户加密保存 API Key，请检查当前 Windows 环境"
                : "无法解密已保存的 API Key，请在当前 Windows 账户下重新填写密钥");
    }

    @Structure.FieldOrder({"cbData", "pbData"})
    public static final class DataBlob extends Structure {
        public int cbData;
        public Pointer pbData;
    }

    interface Crypt32 extends StdCallLibrary {
        Crypt32 INSTANCE = Native.load("crypt32", Crypt32.class);
        boolean CryptProtectData(DataBlob input, WString description, DataBlob entropy, Pointer reserved,
                                 Pointer prompt, int flags, DataBlob output);
        boolean CryptUnprotectData(DataBlob input, Pointer description, DataBlob entropy, Pointer reserved,
                                   Pointer prompt, int flags, DataBlob output);
    }

    interface Kernel32 extends StdCallLibrary {
        Kernel32 INSTANCE = Native.load("kernel32", Kernel32.class);
        Pointer LocalFree(Pointer memory);
    }
}
