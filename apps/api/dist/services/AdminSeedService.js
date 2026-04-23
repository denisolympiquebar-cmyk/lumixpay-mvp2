"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedAdminIfEnabled = seedAdminIfEnabled;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const uuid_1 = require("uuid");
const pool_1 = require("../db/pool");
// ─────────────────────────────────────────────────────────────────────────────
// seedAdminIfEnabled
//
// Called once at API startup.  Reads three env vars:
//   LUMIX_SEED_ADMIN  — must be exactly "true" to activate (default: skip)
//   ADMIN_EMAIL       — email for the admin account
//   ADMIN_PASSWORD    — plaintext password; hashed with bcrypt rounds=12
//                       (same settings as /auth/register)
//
// Behaviour (idempotent — safe on every boot):
//   • User exists, role = 'admin'  → skipped, nothing changes
//   • User exists, role ≠ 'admin'  → role promoted to 'admin', password unchanged
//   • User does not exist           → account created with role='admin'
//                                     + one 'main' account per active asset
//                                     (mirrors the /auth/register flow)
//
// Failures are logged but never crash the server.
// ─────────────────────────────────────────────────────────────────────────────
async function seedAdminIfEnabled() {
    if (process.env["LUMIX_SEED_ADMIN"] !== "true") {
        return; // feature disabled — most common path
    }
    const email = process.env["ADMIN_EMAIL"]?.trim();
    const password = process.env["ADMIN_PASSWORD"]?.trim();
    if (!email) {
        console.warn("[AdminSeed] LUMIX_SEED_ADMIN=true but ADMIN_EMAIL is not set — skipping.");
        return;
    }
    if (!password) {
        console.warn("[AdminSeed] LUMIX_SEED_ADMIN=true but ADMIN_PASSWORD is not set — skipping.");
        return;
    }
    const client = await pool_1.pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT id, role FROM users WHERE email = $1", [email]);
        if (rows.length > 0) {
            const existing = rows[0];
            if (existing.role === "admin") {
                console.log(`[AdminSeed] ${email} already has role=admin — skipped.`);
            }
            else {
                // Promote without touching password or any other field
                await client.query("UPDATE users SET role = 'admin' WHERE id = $1", [existing.id]);
                console.log(`[AdminSeed] Promoted ${email} (id=${existing.id}) to role=admin.`);
            }
        }
        else {
            // Create brand-new admin — mirrors /auth/register logic exactly
            const passwordHash = await bcryptjs_1.default.hash(password, 12);
            const userId = (0, uuid_1.v4)();
            const fullName = email.split("@")[0] ?? "Admin";
            await client.query(`INSERT INTO users (id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4, 'admin')`, [userId, email, passwordHash, fullName]);
            // Provision one 'main' account + balance row per active asset
            const { rows: assets } = await client.query("SELECT id FROM assets WHERE is_active = true ORDER BY currency_code");
            for (const asset of assets) {
                const accountId = (0, uuid_1.v4)();
                await client.query(`INSERT INTO accounts (id, user_id, asset_id, label) VALUES ($1, $2, $3, 'main')`, [accountId, userId, asset.id]);
                await client.query(`INSERT INTO balances (account_id, available, locked) VALUES ($1, 0, 0)`, [accountId]);
            }
            console.log(`[AdminSeed] Created admin account for ${email} (id=${userId}).`);
        }
        await client.query("COMMIT");
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("[AdminSeed] Failed — rolled back:", err);
    }
    finally {
        client.release();
    }
}
//# sourceMappingURL=AdminSeedService.js.map