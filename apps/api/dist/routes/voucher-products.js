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
const config_1 = require("../config");
const router = (0, express_1.Router)();
// ── GET /voucher-products  — public list of purchasable products ──────────────
router.get("/", async (_req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`SELECT vp.*, a.currency_code, a.display_symbol, a.display_name
         FROM voucher_products vp
         JOIN assets a ON a.id = vp.asset_id
        WHERE vp.is_active = TRUE
        ORDER BY a.currency_code, vp.amount`);
        return res.json({ products: rows });
    }
    catch (err) {
        console.error("GET /voucher-products error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── POST /vouchers/purchase  — user buys a voucher using their balance ─────────
const PurchaseSchema = zod_1.z.object({
    product_id: zod_1.z.string().uuid(),
});
router.post("/purchase", auth_1.authenticate, frozen_1.requireNotFrozen, require_idempotency_1.requireIdempotencyKey, idempotency_1.idempotent, async (req, res) => {
    const parsed = PurchaseSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { product_id } = parsed.data;
    const userId = req.user.sub;
    try {
        const result = await (0, pool_1.withTransaction)(async (client) => {
            // 1. Lock and validate the product
            const { rows: pRows } = await client.query("SELECT * FROM voucher_products WHERE id = $1 AND is_active = TRUE FOR UPDATE", [product_id]);
            const product = pRows[0];
            if (!product)
                throw Object.assign(new Error("Product not found or inactive"), { status: 404 });
            const amount = new decimal_js_1.default(product.amount);
            // 2. Resolve user's main account for this asset
            const { rows: accRows } = await client.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [userId, product.asset_id]);
            const userAccount = accRows[0];
            if (!userAccount)
                throw Object.assign(new Error("No account for this asset"), { status: 422 });
            // 3. Check sufficient available balance (FOR UPDATE locks the row)
            const { rows: balRows } = await client.query("SELECT available FROM balances WHERE account_id = $1 FOR UPDATE", [userAccount.id]);
            const available = new decimal_js_1.default(balRows[0]?.available ?? "0");
            if (available.lt(amount)) {
                throw Object.assign(new Error(`Insufficient balance. Need ${amount.toFixed(2)}, have ${available.toFixed(2)}`), { status: 422 });
            }
            // 4. Resolve FLOAT account
            const sysAccounts = config_1.config.system.accounts;
            const isRlusd = product.asset_id === sysAccounts.rlusd.assetId;
            const floatAccountId = isRlusd ? sysAccounts.rlusd.float : sysAccounts.eurq.float;
            // 5. Generate secure voucher code
            const code = crypto_1.default.randomBytes(4).toString("hex").toUpperCase();
            const voucherId = crypto_1.default.randomUUID();
            const idempKey = `voucher_purchase:${voucherId}`;
            // 6. Post ledger entry: user → FLOAT (payment for voucher)
            await client.query(`INSERT INTO ledger_entries
           (idempotency_key, debit_account_id, credit_account_id, asset_id, amount,
            entry_type, reference_id, reference_type)
         VALUES ($1, $2, $3, $4, $5, 'voucher', $6, 'vouchers')`, [idempKey, userAccount.id, floatAccountId, product.asset_id, amount.toFixed(6), voucherId]);
            // 7. Debit user balance, credit FLOAT
            await client.query("UPDATE balances SET available = available - $1, updated_at = NOW() WHERE account_id = $2", [amount.toFixed(6), userAccount.id]);
            await client.query("UPDATE balances SET available = available + $1, updated_at = NOW() WHERE account_id = $2", [amount.toFixed(6), floatAccountId]);
            // 8. Create voucher
            const { rows: vRows } = await client.query(`INSERT INTO vouchers
           (id, code, asset_id, gross_amount, status, created_by_admin_id, purchased_by_user_id)
         VALUES ($1, $2, $3, $4, 'active', NULL, $5)
         RETURNING *`, [voucherId, code, product.asset_id, amount.toFixed(6), userId]);
            return { voucher: vRows[0], amount: amount.toFixed(2), currency: product.display_symbol };
        });
        void NotificationService_1.notificationService.create({
            userId,
            type: "voucher.purchased",
            title: "Voucher purchased",
            body: `You purchased a ${result.currency} ${result.amount} voucher. Code: ${result.voucher.code}`,
            metadata: { voucher_id: result.voucher.id, code: result.voucher.code, amount: result.amount },
        }).catch(() => { });
        return res.status(201).json({ voucher: result.voucher, code: result.voucher.code });
    }
    catch (err) {
        console.error("POST /vouchers/purchase error:", err);
        return res.status(err.status ?? 500).json({ error: err.message ?? "Purchase failed" });
    }
});
// ── GET /vouchers/mine  — list vouchers purchased by the current user ──────────
router.get("/mine", auth_1.authenticate, async (req, res) => {
    const userId = req.user.sub;
    try {
        const { rows } = await pool_1.pool.query(`SELECT v.*, a.currency_code, a.display_symbol
         FROM vouchers v
         JOIN assets a ON a.id = v.asset_id
        WHERE v.purchased_by_user_id = $1
        ORDER BY v.created_at DESC
        LIMIT 50`, [userId]);
        return res.json({ vouchers: rows });
    }
    catch (err) {
        console.error("GET /vouchers/mine error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
exports.default = router;
//# sourceMappingURL=voucher-products.js.map