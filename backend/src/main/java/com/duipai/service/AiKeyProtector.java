package com.duipai.service;

import com.sun.jna.Platform;

/** Encrypts API keys for local storage; implementations must never return plaintext as ciphertext. */
interface AiKeyProtector {
    String protect(String apiKey);
    String unprotect(String encryptedApiKey);

    /** Removes any secret held outside the settings file after the stored value is no longer referenced. */
    default void discard(String encryptedApiKey) { }

    static AiKeyProtector forCurrentPlatform() {
        return Platform.isMac() ? new MacKeychainAiKeyProtector() : new WindowsAiKeyProtector();
    }
}
