package com.duipai.service;

/** Encrypts API keys for local storage; implementations must never return plaintext as ciphertext. */
interface AiKeyProtector {
    String protect(String apiKey);
    String unprotect(String encryptedApiKey);
}
