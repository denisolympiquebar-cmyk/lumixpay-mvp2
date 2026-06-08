export declare class WalletEncryptionService {
    private readonly key;
    private readonly keyId;
    constructor(masterKeyBase64url: string, keyId: string);
    /**
     * Encrypts a plaintext string (e.g. an XRPL family seed).
     * Returns the portable envelope string suitable for storing in the DB.
     * Uses a fresh random IV on every call — safe to call multiple times
     * for the same plaintext.
     */
    encrypt(plaintext: string): string;
    /**
     * Decrypts an envelope string produced by encrypt().
     * Throws if:
     *   - The envelope format is invalid (wrong number of parts)
     *   - The auth tag check fails (tampered data or wrong key)
     *
     * NEVER log or expose the return value — it is the raw plaintext seed.
     */
    decrypt(encoded: string): string;
}
//# sourceMappingURL=WalletEncryptionService.d.ts.map