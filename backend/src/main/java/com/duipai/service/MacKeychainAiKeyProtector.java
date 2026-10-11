package com.duipai.service;

import com.sun.jna.Library;
import com.sun.jna.Native;
import com.sun.jna.NativeLibrary;
import com.sun.jna.Platform;
import com.sun.jna.Pointer;
import com.sun.jna.ptr.PointerByReference;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** The macOS login keychain holds the key; the settings file only stores a reference to the keychain item. */
final class MacKeychainAiKeyProtector implements AiKeyProtector {
    private static final String PREFIX = "keychain:v1:";
    private static final String ACCOUNT = "ai-api-key";
    private static final int ERR_SEC_SUCCESS = 0;
    private static final int ERR_SEC_ITEM_NOT_FOUND = -25300;
    private static final int ERR_SEC_USER_CANCELED = -128;
    private static final int ERR_SEC_AUTH_FAILED = -25293;
    private static final int ERR_SEC_INTERACTION_NOT_ALLOWED = -25308;
    private static final int CF_STRING_ENCODING_UTF8 = 0x08000100;
    private final String service;

    MacKeychainAiKeyProtector() { this("local.duipai.workbench"); }

    /** Tests use a separate service so they never touch the user's saved key. */
    MacKeychainAiKeyProtector(String service) { this.service = service; }

    @Override public String protect(String apiKey) {
        if (!Platform.isMac()) throw unavailable(true, 0);
        byte[] plaintext = apiKey.getBytes(StandardCharsets.UTF_8);
        try (CfScope cf = new CfScope()) {
            Pointer data = cf.data(plaintext);
            int status = Frameworks.security().SecItemUpdate(query(cf), cf.dictionary(Frameworks.constant("kSecValueData"), data));
            if (status == ERR_SEC_ITEM_NOT_FOUND)
                status = Frameworks.security().SecItemAdd(query(cf, Frameworks.constant("kSecValueData"), data), null);
            if (status != ERR_SEC_SUCCESS) throw unavailable(true, status);
            return PREFIX + ACCOUNT;
        } catch (LinkageError error) {
            throw unavailable(true, 0);
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
    }

    @Override public String unprotect(String encryptedApiKey) {
        if (!(PREFIX + ACCOUNT).equals(encryptedApiKey) || !Platform.isMac()) throw unavailable(false, 0);
        try (CfScope cf = new CfScope()) {
            PointerByReference result = new PointerByReference();
            int status = Frameworks.security().SecItemCopyMatching(query(cf,
                    Frameworks.constant("kSecReturnData"), Frameworks.constant("kCFBooleanTrue"),
                    Frameworks.constant("kSecMatchLimit"), Frameworks.constant("kSecMatchLimitOne")), result);
            if (status != ERR_SEC_SUCCESS || result.getValue() == null) throw unavailable(false, status);
            Pointer data = cf.own(result.getValue());
            long length = Frameworks.coreFoundation().CFDataGetLength(data);
            if (length <= 0 || length > 64 * 1024) throw unavailable(false, 0);
            byte[] plaintext = Frameworks.coreFoundation().CFDataGetBytePtr(data).getByteArray(0, (int) length);
            try { return new String(plaintext, StandardCharsets.UTF_8); }
            finally { Arrays.fill(plaintext, (byte) 0); }
        } catch (LinkageError error) {
            throw unavailable(false, 0);
        }
    }

    @Override public void discard(String encryptedApiKey) {
        if (!(PREFIX + ACCOUNT).equals(encryptedApiKey) || !Platform.isMac()) return;
        try (CfScope cf = new CfScope()) {
            int status = Frameworks.security().SecItemDelete(query(cf));
            if (status != ERR_SEC_SUCCESS && status != ERR_SEC_ITEM_NOT_FOUND) throw unavailable(true, status);
        } catch (LinkageError error) {
            throw unavailable(true, 0);
        }
    }

    private Pointer query(CfScope cf, Pointer... extra) {
        Pointer[] pairs = new Pointer[6 + extra.length];
        pairs[0] = Frameworks.constant("kSecClass"); pairs[1] = Frameworks.constant("kSecClassGenericPassword");
        pairs[2] = Frameworks.constant("kSecAttrService"); pairs[3] = cf.string(service);
        pairs[4] = Frameworks.constant("kSecAttrAccount"); pairs[5] = cf.string(ACCOUNT);
        System.arraycopy(extra, 0, pairs, 6, extra.length);
        return cf.dictionary(pairs);
    }

    private ResponseStatusException unavailable(boolean store, int status) {
        if (status == ERR_SEC_USER_CANCELED || status == ERR_SEC_AUTH_FAILED || status == ERR_SEC_INTERACTION_NOT_ALLOWED)
            return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "未获得钥匙串访问权限，请在系统弹窗中点击“始终允许”后重试");
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, store
                ? "无法将 API Key 保存到 macOS 钥匙串，请检查“钥匙串访问”中的登录钥匙串是否可用"
                : "无法从 macOS 钥匙串读取已保存的 API Key，请重新填写密钥");
    }

    /** Releases every Core Foundation object created for one keychain call. */
    private static final class CfScope implements AutoCloseable {
        private final List<Pointer> owned = new ArrayList<>();

        Pointer own(Pointer object) {
            if (object == null) throw new IllegalStateException("Core Foundation allocation failed");
            owned.add(object);
            return object;
        }

        Pointer string(String value) {
            byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
            return own(Frameworks.coreFoundation().CFStringCreateWithBytes(null, bytes, bytes.length, CF_STRING_ENCODING_UTF8, (byte) 0));
        }

        Pointer data(byte[] bytes) { return own(Frameworks.coreFoundation().CFDataCreate(null, bytes, bytes.length)); }

        Pointer dictionary(Pointer... pairs) {
            int count = pairs.length / 2;
            Pointer[] keys = new Pointer[count], values = new Pointer[count];
            for (int i = 0; i < count; i++) { keys[i] = pairs[2 * i]; values[i] = pairs[2 * i + 1]; }
            return own(Frameworks.coreFoundation().CFDictionaryCreate(null, keys, values, count,
                    Frameworks.KEY_CALLBACKS, Frameworks.VALUE_CALLBACKS));
        }

        @Override public void close() {
            for (int i = owned.size() - 1; i >= 0; i--) Frameworks.coreFoundation().CFRelease(owned.get(i));
        }
    }

    /** Frameworks load on first use, so this class can be referenced on Windows without touching macOS libraries. */
    private static final class Frameworks {
        private static final NativeLibrary SECURITY_LIBRARY = NativeLibrary.getInstance("Security");
        private static final NativeLibrary CF_LIBRARY = NativeLibrary.getInstance("CoreFoundation");
        private static final Security SECURITY = Native.load("Security", Security.class);
        private static final CoreFoundation CORE_FOUNDATION = Native.load("CoreFoundation", CoreFoundation.class);
        static final Pointer KEY_CALLBACKS = CF_LIBRARY.getGlobalVariableAddress("kCFTypeDictionaryKeyCallBacks");
        static final Pointer VALUE_CALLBACKS = CF_LIBRARY.getGlobalVariableAddress("kCFTypeDictionaryValueCallBacks");

        static Security security() { return SECURITY; }
        static CoreFoundation coreFoundation() { return CORE_FOUNDATION; }

        /** Reads an exported constant such as kSecClass; each one is a pointer-sized variable holding a CF object. */
        static Pointer constant(String name) {
            NativeLibrary library = name.startsWith("kCF") ? CF_LIBRARY : SECURITY_LIBRARY;
            return library.getGlobalVariableAddress(name).getPointer(0);
        }
    }

    interface Security extends Library {
        int SecItemAdd(Pointer attributes, PointerByReference result);
        int SecItemUpdate(Pointer query, Pointer attributesToUpdate);
        int SecItemCopyMatching(Pointer query, PointerByReference result);
        int SecItemDelete(Pointer query);
    }

    interface CoreFoundation extends Library {
        Pointer CFStringCreateWithBytes(Pointer allocator, byte[] bytes, long length, int encoding, byte external);
        Pointer CFDataCreate(Pointer allocator, byte[] bytes, long length);
        Pointer CFDictionaryCreate(Pointer allocator, Pointer[] keys, Pointer[] values, long count,
                                   Pointer keyCallBacks, Pointer valueCallBacks);
        long CFDataGetLength(Pointer data);
        Pointer CFDataGetBytePtr(Pointer data);
        void CFRelease(Pointer object);
    }
}
