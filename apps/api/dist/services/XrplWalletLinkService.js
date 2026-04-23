"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.XRPL_PROFILE_NETWORK = exports.XRPL_TESTNET_PUBLIC_WSS = exports.XRPL_TESTNET_PUBLIC_JSON_RPC = void 0;
exports.createWalletChallenge = createWalletChallenge;
exports.verifyAndLinkWallet = verifyAndLinkWallet;
exports.unlinkWallet = unlinkWallet;
const crypto_1 = __importDefault(require("crypto"));
const ripple_address_codec_1 = require("ripple-address-codec");
const ripple_keypairs_1 = require("ripple-keypairs");
const pool_1 = require("../db/pool");
/** Public XRPL Testnet JSON-RPC (for docs / UI; settlement is not enabled in MVP). */
exports.XRPL_TESTNET_PUBLIC_JSON_RPC = "https://s.altnet.rippletest.net:51234";
exports.XRPL_TESTNET_PUBLIC_WSS = "wss://s.altnet.rippletest.net/";
exports.XRPL_PROFILE_NETWORK = "xrpl_testnet";
const CHALLENGE_TTL_MS = 15 * 60 * 1000;
function normalizeHex(s) {
    let x = s.trim().replace(/^0x/i, "");
    x = x.replace(/\s+/g, "");
    return x.toUpperCase();
}
function buildMessage(params) {
    return [
        "LumixPay — link XRPL Testnet wallet to this LumixPay account",
        `User ID: ${params.userId}`,
        `Email: ${params.email}`,
        `Nonce: ${params.nonce}`,
        `Expires (UTC): ${params.expiresIso}`,
        "",
        "Network: XRPL Testnet only.",
        "",
        "Sign the exact UTF-8 text of this message with your XRPL account key.",
        "Use ripple-keypairs (or a compatible wallet) so the signature matches this message.",
    ].join("\n");
}
async function createWalletChallenge(userId) {
    const { rows: userRows } = await pool_1.pool.query("SELECT email FROM users WHERE id = $1 AND role != 'system'", [userId]);
    if (!userRows[0])
        throw new Error("USER_NOT_FOUND");
    const nonce = crypto_1.default.randomUUID();
    const expires = new Date(Date.now() + CHALLENGE_TTL_MS);
    const expiresIso = expires.toISOString();
    const message = buildMessage({
        userId,
        email: userRows[0].email,
        nonce,
        expiresIso,
    });
    const client = await pool_1.pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM wallet_link_challenges WHERE expires_at < NOW()");
        await client.query("DELETE FROM wallet_link_challenges WHERE user_id = $1", [userId]);
        const { rows } = await client.query(`INSERT INTO wallet_link_challenges (user_id, message, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id`, [userId, message, expires]);
        await client.query("COMMIT");
        const id = rows[0].id;
        return {
            challenge_id: id,
            message,
            expires_at: expiresIso,
            network: exports.XRPL_PROFILE_NETWORK,
            xrpl_testnet_json_rpc: exports.XRPL_TESTNET_PUBLIC_JSON_RPC,
            xrpl_testnet_wss: exports.XRPL_TESTNET_PUBLIC_WSS,
        };
    }
    catch (e) {
        try {
            await client.query("ROLLBACK");
        }
        catch {
            /* ignore */
        }
        throw e;
    }
    finally {
        client.release();
    }
}
function messageToHex(message) {
    return Buffer.from(message, "utf8").toString("hex").toUpperCase();
}
async function verifyAndLinkWallet(userId, input) {
    const address = input.address.trim();
    if (!(0, ripple_address_codec_1.isValidClassicAddress)(address)) {
        const err = new Error("XRPL_ADDRESS_INVALID");
        err.code = "XRPL_ADDRESS_INVALID";
        throw err;
    }
    const publicKey = normalizeHex(input.public_key);
    const signature = normalizeHex(input.signature);
    const client = await pool_1.pool.connect();
    try {
        await client.query("BEGIN");
        const { rows: chRows } = await client.query(`SELECT message, expires_at, user_id FROM wallet_link_challenges WHERE id = $1 FOR UPDATE`, [input.challenge_id]);
        const ch = chRows[0];
        if (!ch || ch.user_id !== userId) {
            const err = new Error("WALLET_CHALLENGE_INVALID");
            err.code = "WALLET_CHALLENGE_INVALID";
            throw err;
        }
        if (new Date(ch.expires_at) < new Date()) {
            const err = new Error("WALLET_CHALLENGE_EXPIRED");
            err.code = "WALLET_CHALLENGE_EXPIRED";
            throw err;
        }
        let derived;
        try {
            derived = (0, ripple_keypairs_1.deriveAddress)(publicKey);
        }
        catch {
            const err = new Error("XRPL_PUBLIC_KEY_INVALID");
            err.code = "XRPL_PUBLIC_KEY_INVALID";
            throw err;
        }
        if (derived !== address) {
            const err = new Error("XRPL_ADDRESS_KEY_MISMATCH");
            err.code = "XRPL_ADDRESS_KEY_MISMATCH";
            throw err;
        }
        const messageHex = messageToHex(ch.message);
        let ok = false;
        try {
            ok = (0, ripple_keypairs_1.verify)(messageHex, signature, publicKey);
        }
        catch {
            ok = false;
        }
        if (!ok) {
            const err = new Error("XRPL_SIGNATURE_INVALID");
            err.code = "XRPL_SIGNATURE_INVALID";
            throw err;
        }
        const { rows: conflict } = await client.query("SELECT id FROM users WHERE xrpl_address = $1 AND id != $2", [address, userId]);
        if (conflict.length > 0) {
            const err = new Error("XRPL_ADDRESS_ALREADY_LINKED");
            err.code = "XRPL_ADDRESS_ALREADY_LINKED";
            throw err;
        }
        await client.query(`UPDATE users SET
         xrpl_address = $1,
         xrpl_network = $2,
         xrpl_verified_at = NOW()
       WHERE id = $3`, [address, exports.XRPL_PROFILE_NETWORK, userId]);
        await client.query("DELETE FROM wallet_link_challenges WHERE id = $1", [input.challenge_id]);
        await client.query("COMMIT");
    }
    catch (e) {
        try {
            await client.query("ROLLBACK");
        }
        catch {
            /* ignore */
        }
        throw e;
    }
    finally {
        client.release();
    }
}
async function unlinkWallet(userId) {
    await pool_1.pool.query(`UPDATE users SET xrpl_address = NULL, xrpl_network = NULL, xrpl_verified_at = NULL
     WHERE id = $1`, [userId]);
    await pool_1.pool.query("DELETE FROM wallet_link_challenges WHERE user_id = $1", [userId]);
}
//# sourceMappingURL=XrplWalletLinkService.js.map