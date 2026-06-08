"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletEncryptionService = void 0;
const crypto_1 = __importDefault(require("crypto"));
// ─────────────────────────────────────────────────────────────────────────────
// WalletEncryptionService
//
// AES-256-GCM envelope encryption for custodial XRPL wallet seeds.
//
// Stored format (value written to user_wallets.encrypted_seed):
//   "<keyId>:<iv_base64url>:<authTag_base64url>:<ciphertext_base64url>"
//
// Example:
//   "v1:abc123...:xyz789...:ct_base64..."
//
// Security properties:
//   - AES-256-GCM provides authenticated encryption: any bit-flip in the
//     ciphertext or auth-tag will cause decrypt() to throw, preventing silent
//     data corruption or forgery.
//   - Each encryption uses a fresh random 12-byte IV (GCM standard) so the
//     same plaintext never produces the same ciphertext, even with the same key.
//   - The key version prefix ("v1") enables key rotation without breaking
//     existing ciphertexts: a future decrypt() implementation can select the
//     correct key by reading the prefix.
//
// Key rotation:
//   To rotate to key v2, generate a new WALLET_MASTER_KEY, set
//   WALLET_ENCRYPTION_KEY_ID=v2, and run a background job that re-encrypts
//   rows with encryption_key_id='v1' using the v2 key.
//
// ── SECURITY WARNING ─────────────────────────────────────────────────────────
// This service uses a single env-var master key.  For testnet this is
// acceptable.  Before handling real funds on mainnet, migrate to a KMS/HSM
// (AWS KMS, GCP Cloud KMS, HashiCorp Vault) where the plaintext key never
// leaves the HSM boundary.
// ─────────────────────────────────────────────────────────────────────────────
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // recommended GCM IV length
const SEPARATOR = ":";
class WalletEncryptionService {
    key;
    keyId;
    constructor(masterKeyBase64url, keyId) {
        if (!masterKeyBase64url) {
            throw new Error("WalletEncryptionService: WALLET_MASTER_KEY is not set. " +
                'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
        }
        const decoded = Buffer.from(masterKeyBase64url, "base64url");
        if (decoded.length !== 32) {
            throw new Error(`WalletEncryptionService: WALLET_MASTER_KEY must decode to exactly 32 bytes ` +
                `(got ${decoded.length}). Re-generate with: ` +
                'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
        }
        this.key = decoded;
        this.keyId = keyId;
    }
    /**
     * Encrypts a plaintext string (e.g. an XRPL family seed).
     * Returns the portable envelope string suitable for storing in the DB.
     * Uses a fresh random IV on every call — safe to call multiple times
     * for the same plaintext.
     */
    encrypt(plaintext) {
        const iv = crypto_1.default.randomBytes(IV_BYTES);
        const cipher = crypto_1.default.createCipheriv(ALGORITHM, this.key, iv);
        const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag(); // 16-byte GCM auth tag
        return [
            this.keyId,
            iv.toString("base64url"),
            tag.toString("base64url"),
            ct.toString("base64url"),
        ].join(SEPARATOR);
    }
    /**
     * Decrypts an envelope string produced by encrypt().
     * Throws if:
     *   - The envelope format is invalid (wrong number of parts)
     *   - The auth tag check fails (tampered data or wrong key)
     *
     * NEVER log or expose the return value — it is the raw plaintext seed.
     */
    decrypt(encoded) {
        const parts = encoded.split(SEPARATOR);
        if (parts.length !== 4) {
            throw new Error(`WalletEncryptionService: malformed envelope — expected 4 colon-separated parts, ` +
                `got ${parts.length}.`);
        }
        // keyId (parts[0]) is the version prefix — reserved for key rotation dispatch.
        // Currently only "v1" exists; future versions will select the correct key here.
        const [_keyId, ivB64, tagB64, ctB64] = parts;
        const iv = Buffer.from(ivB64, "base64url");
        const authTag = Buffer.from(tagB64, "base64url");
        const ciphertext = Buffer.from(ctB64, "base64url");
        const decipher = crypto_1.default.createDecipheriv(ALGORITHM, this.key, iv);
        decipher.setAuthTag(authTag);
        try {
            const plaintext = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]);
            return plaintext.toString("utf8");
        }
        catch {
            // Do NOT include any ciphertext or key material in the error message.
            throw new Error("WalletEncryptionService: decryption failed — invalid key, wrong key version, or tampered data.");
        }
    }
}
exports.WalletEncryptionService = WalletEncryptionService;
//# sourceMappingURL=WalletEncryptionService.js.map