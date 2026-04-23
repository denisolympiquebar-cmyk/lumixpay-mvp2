"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const crypto_1 = __importDefault(require("crypto"));
const decimal_js_1 = __importDefault(require("decimal.js"));
const auth_1 = require("../middleware/auth");
const frozen_1 = require("../middleware/frozen");
const idempotency_1 = require("../middleware/idempotency");
const require_idempotency_1 = require("../middleware/require-idempotency");
const pool_1 = require("../db/pool");
const NotificationService_1 = require("../services/NotificationService");
const TreasuryService_1 = require("../services/TreasuryService");
const config_1 = require("../config");
const router = (0, express_1.Router)();
// ── Admin endpoints ───────────────────────────────────────────────────────────
const CreateVoucherSchema = zod_1.z.object({
    asset_id: zod_1.z.string().uuid(),
    gross_amount: zod_1.z.number().positive(),
    expires_at: zod_1.z.string().datetime().optional(),
});
// POST /admin/vouchers  — admin creates a voucher
router.post("/admin", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    const parsed = CreateVoucherSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { asset_id, gross_amount, expires_at } = parsed.data;
    // Secure random code: 8 uppercase hex chars (32-bit entropy)
    const code = crypto_1.default.randomBytes(4).toString("hex").toUpperCase();
    try {
        const { rows } = await pool_1.pool.query(`INSERT INTO vouchers (code, asset_id, gross_amount, created_by_admin_id, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`, [code, asset_id, gross_amount, req.user.sub, expires_at ?? null]);
        return res.status(201).json({ voucher: rows[0] });
    }
    catch (err) {
        console.error("POST /admin/vouchers error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// GET /admin/vouchers
router.get("/admin", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`SELECT v.*, a.currency_code, a.display_symbol
         FROM vouchers v
         JOIN assets a ON a.id = v.asset_id
        ORDER BY v.created_at DESC`);
        return res.json({ vouchers: rows });
    }
    catch (err) {
        console.error("GET /admin/vouchers error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// POST /admin/vouchers/:id/disable
router.post("/admin/:id/disable", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    try {
        const { rowCount } = await pool_1.pool.query("UPDATE vouchers SET status = 'disabled' WHERE id = $1 AND status = 'active'", [req.params["id"]]);
        if (!rowCount)
            return res.status(404).json({ error: "Active voucher not found" });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("POST /admin/vouchers/:id/disable error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── Admin: Voucher product catalog management ─────────────────────────────────
const CreateProductSchema = zod_1.z.object({
    asset_id: zod_1.z.string().uuid(),
    amount: zod_1.z.number().positive(),
});
// GET /vouchers/admin/products — list all products (active + inactive)
router.get("/admin/products", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (_req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`SELECT vp.*, a.currency_code, a.display_symbol, a.display_name
         FROM voucher_products vp
         JOIN assets a ON a.id = vp.asset_id
        ORDER BY a.currency_code, vp.amount`);
        return res.json({ products: rows });
    }
    catch (err) {
        console.error("GET /vouchers/admin/products error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// POST /vouchers/admin/products — create a new purchasable product
router.post("/admin/products", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    const parsed = CreateProductSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { asset_id, amount } = parsed.data;
    try {
        const { rows } = await pool_1.pool.query(`INSERT INTO voucher_products (asset_id, amount, is_active)
       VALUES ($1, $2, TRUE) RETURNING *`, [asset_id, new decimal_js_1.default(amount).toFixed(6)]);
        return res.status(201).json({ product: rows[0] });
    }
    catch (err) {
        console.error("POST /vouchers/admin/products error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// PATCH /vouchers/admin/products/:id/toggle — activate or deactivate a product
router.patch("/admin/products/:id/toggle", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    try {
        const { rows, rowCount } = await pool_1.pool.query(`UPDATE voucher_products
          SET is_active = NOT is_active
        WHERE id = $1
        RETURNING *`, [req.params["id"]]);
        if (!rowCount)
            return res.status(404).json({ error: "Product not found" });
        return res.json({ product: rows[0] });
    }
    catch (err) {
        console.error("PATCH /vouchers/admin/products/:id/toggle error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── User endpoint ─────────────────────────────────────────────────────────────
const RedeemSchema = zod_1.z.object({ code: zod_1.z.string().min(1) });
// POST /vouchers/redeem
router.post("/redeem", auth_1.authenticate, frozen_1.requireNotFrozen, require_idempotency_1.requireIdempotencyKey, idempotency_1.idempotent, async (req, res) => {
    const parsed = RedeemSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { code } = parsed.data;
    const userId = req.user.sub;
    try {
        const result = await (0, pool_1.withTransaction)(async (client) => {
            // Lock the voucher row
            const { rows: vRows } = await client.query("SELECT * FROM vouchers WHERE code = $1 FOR UPDATE", [code.toUpperCase()]);
            const voucher = vRows[0];
            if (!voucher)
                throw Object.assign(new Error("Voucher not found"), { status: 404 });
            if (voucher.status === "redeemed")
                throw Object.assign(new Error("Voucher already redeemed"), { status: 409 });
            if (voucher.status === "disabled")
                throw Object.assign(new Error("Voucher is disabled"), { status: 410 });
            if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
                throw Object.assign(new Error("Voucher has expired"), { status: 410 });
            }
            // Resolve user's main account for this asset
            const { rows: accRows } = await client.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [userId, voucher.asset_id]);
            if (!accRows[0])
                throw Object.assign(new Error("No account for this asset"), { status: 422 });
            // Resolve FLOAT account for the asset
            const sysAccounts = config_1.config.system.accounts;
            const isRlusd = voucher.asset_id === sysAccounts.rlusd.assetId;
            const floatAccountId = isRlusd ? sysAccounts.rlusd.float : sysAccounts.eurq.float;
            const gross = new decimal_js_1.default(voucher.gross_amount);
            const idempKey = `voucher:${voucher.id}:${userId}`;
            // Treasury gate: only admin-created vouchers mint new supply.
            // User-purchased vouchers (purchased_by_user_id IS NOT NULL) don't mint
            // because the buyer already paid from circulating balance.
            const isAdminVoucher = voucher.created_by_admin_id != null && !("purchased_by_user_id" in voucher && voucher.purchased_by_user_id);
            if (isAdminVoucher) {
                await TreasuryService_1.treasuryService.ensureCanIssue(client, voucher.asset_id, gross);
            }
            // Post ledger entry: FLOAT → user (full gross, no fee for voucher)
            await client.query(`INSERT INTO ledger_entries
           (idempotency_key, debit_account_id, credit_account_id, asset_id, amount, entry_type, reference_id, reference_type)
         VALUES ($1,$2,$3,$4,$5,'voucher',$6,'voucher')`, [idempKey, floatAccountId, accRows[0].id, voucher.asset_id, gross.toFixed(6), voucher.id]);
            // Update balances: FLOAT.available -= gross, user.available += gross
            await client.query("UPDATE balances SET available = available - $1, updated_at = NOW() WHERE account_id = $2", [gross.toFixed(6), floatAccountId]);
            await client.query("UPDATE balances SET available = available + $1, updated_at = NOW() WHERE account_id = $2", [gross.toFixed(6), accRows[0].id]);
            // Record treasury issuance for admin-created vouchers
            if (isAdminVoucher) {
                await TreasuryService_1.treasuryService.issue(client, voucher.asset_id, gross);
            }
            // Mark voucher redeemed
            await client.query("UPDATE vouchers SET status = 'redeemed', redeemed_by_user_id = $1, redeemed_at = NOW() WHERE id = $2", [userId, voucher.id]);
            return { voucher, credited: gross.toFixed(2) };
        });
        void NotificationService_1.notificationService.create({
            userId,
            type: "voucher.redeemed",
            title: "Voucher redeemed",
            body: `${result.credited} credited to your account`,
            metadata: { voucher_id: result.voucher.id, amount: result.credited },
        }).catch(() => { });
        return res.json({ ok: true, credited: result.credited });
    }
    catch (err) {
        console.error("POST /vouchers/redeem error:", err);
        return res.status(err.status ?? 500).json({ error: err.message ?? "Redemption failed" });
    }
});
exports.default = router;
//# sourceMappingURL=vouchers.js.map