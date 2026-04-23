"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const uuid_1 = require("uuid");
const decimal_js_1 = __importDefault(require("decimal.js"));
const auth_1 = require("../middleware/auth");
const frozen_1 = require("../middleware/frozen");
const idempotency_1 = require("../middleware/idempotency");
const pool_1 = require("../db/pool");
const NotificationService_1 = require("../services/NotificationService");
const config_1 = require("../config");
const router = (0, express_1.Router)();
// ── GET /fx-rate?base=<asset_id>&quote=<asset_id>  ────────────────────────────
router.get("/", async (req, res) => {
    const { base, quote } = req.query;
    if (!base || !quote) {
        return res.status(400).json({ error: "base and quote asset IDs are required" });
    }
    try {
        const { rows } = await pool_1.pool.query(`SELECT fr.rate, fr.updated_at,
              b.currency_code AS base_code, b.display_symbol AS base_symbol,
              q.currency_code AS quote_code, q.display_symbol AS quote_symbol
         FROM fx_rates fr
         JOIN assets b ON b.id = fr.base_asset
         JOIN assets q ON q.id = fr.quote_asset
        WHERE fr.base_asset = $1 AND fr.quote_asset = $2`, [base, quote]);
        if (!rows[0])
            return res.status(404).json({ error: "No FX rate for this pair" });
        return res.json({ rate: rows[0] });
    }
    catch (err) {
        console.error("GET /fx-rate error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── GET /fx-rates  — all rates ─────────────────────────────────────────────────
router.get("/all", async (_req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`SELECT fr.id, fr.rate, fr.updated_at,
              b.id AS base_asset_id, b.currency_code AS base_code, b.display_symbol AS base_symbol,
              q.id AS quote_asset_id, q.currency_code AS quote_code, q.display_symbol AS quote_symbol
         FROM fx_rates fr
         JOIN assets b ON b.id = fr.base_asset
         JOIN assets q ON q.id = fr.quote_asset
        ORDER BY b.currency_code, q.currency_code`);
        return res.json({ rates: rows });
    }
    catch (err) {
        console.error("GET /fx-rates/all error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── POST /convert  — convert between assets ────────────────────────────────────
// NOTE: this router is mounted at app.use("/convert", fxRouter) in index.ts.
// Express strips the mount prefix, so this handler must use path "/" (not "/convert").
const ConvertSchema = zod_1.z.object({
    from_asset_id: zod_1.z.string().uuid(),
    to_asset_id: zod_1.z.string().uuid(),
    amount: zod_1.z.number().positive(),
});
router.post("/", auth_1.authenticate, frozen_1.requireNotFrozen, idempotency_1.idempotent, async (req, res) => {
    const parsed = ConvertSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { from_asset_id, to_asset_id, amount } = parsed.data;
    const userId = req.user.sub;
    if (from_asset_id === to_asset_id) {
        return res.status(400).json({ error: "Cannot convert an asset to itself" });
    }
    try {
        const result = await (0, pool_1.withTransaction)(async (client) => {
            // 1. Load FX rate (locked for read)
            const { rows: rateRows } = await client.query(`SELECT fr.rate, b.currency_code AS from_code, q.currency_code AS to_code
           FROM fx_rates fr
           JOIN assets b ON b.id = fr.base_asset
           JOIN assets q ON q.id = fr.quote_asset
          WHERE fr.base_asset = $1 AND fr.quote_asset = $2`, [from_asset_id, to_asset_id]);
            if (!rateRows[0])
                throw Object.assign(new Error("No FX rate for this asset pair"), { status: 404 });
            const rate = new decimal_js_1.default(rateRows[0].rate);
            const fromAmt = new decimal_js_1.default(amount);
            const toAmt = fromAmt.mul(rate).toDecimalPlaces(6);
            // 2. Resolve user accounts (FOR UPDATE to lock balance rows)
            const { rows: accRows } = await client.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = ANY($2) AND label = 'main'", [userId, [from_asset_id, to_asset_id]]);
            const fromAcc = accRows.find((a) => a.asset_id === from_asset_id);
            const toAcc = accRows.find((a) => a.asset_id === to_asset_id);
            if (!fromAcc)
                throw Object.assign(new Error("Source account not found"), { status: 422 });
            if (!toAcc)
                throw Object.assign(new Error("Destination account not found"), { status: 422 });
            // 3. Check sufficient balance
            const { rows: balRows } = await client.query("SELECT available FROM balances WHERE account_id = $1 FOR UPDATE", [fromAcc.id]);
            // Also lock destination balance
            await client.query("SELECT available FROM balances WHERE account_id = $1 FOR UPDATE", [toAcc.id]);
            const available = new decimal_js_1.default(balRows[0]?.available ?? "0");
            if (available.lt(fromAmt)) {
                throw Object.assign(new Error(`Insufficient balance. Need ${fromAmt.toFixed(2)}, have ${available.toFixed(2)}`), { status: 422 });
            }
            // 4. Resolve FLOAT accounts for each asset — they act as the cross-currency bridge.
            //    Leg 1 (out): fromAcc  → FLOAT_from  (user gives source asset to float)
            //    Leg 2 (in):  FLOAT_to → toAcc       (float gives destination asset to user)
            const sysAcc = config_1.config.system.accounts;
            const floatFromId = from_asset_id === sysAcc.rlusd.assetId
                ? sysAcc.rlusd.float
                : sysAcc.eurq.float;
            const floatToId = to_asset_id === sysAcc.rlusd.assetId
                ? sysAcc.rlusd.float
                : sysAcc.eurq.float;
            // Lock FLOAT balances for UPDATE so concurrent FX requests don't race
            await client.query("SELECT available FROM balances WHERE account_id = ANY($1) FOR UPDATE", [[floatFromId, floatToId]]);
            // Verify FLOAT_to has enough to pay out
            const { rows: floatToBalRows } = await client.query("SELECT available FROM balances WHERE account_id = $1", [floatToId]);
            const floatToAvail = new decimal_js_1.default(floatToBalRows[0]?.available ?? "0");
            if (floatToAvail.lt(toAmt)) {
                throw Object.assign(new Error("Insufficient platform liquidity for this conversion. Try again later."), { status: 503 });
            }
            // 5. Post two ledger entries using real debit ≠ credit accounts
            const conversionId = (0, uuid_1.v4)();
            const idempKeyDebit = `fx:${conversionId}:debit`;
            const idempKeyCredit = `fx:${conversionId}:credit`;
            // Leg 1 — from-asset "out": user → FLOAT_from
            await client.query(`INSERT INTO ledger_entries
           (idempotency_key, debit_account_id, credit_account_id, asset_id, amount,
            entry_type, reference_id, reference_type, metadata)
         VALUES ($1, $2, $3, $4, $5, 'fx_conversion', $6, 'fx_conversion', $7)`, [
                idempKeyDebit,
                fromAcc.id, // $2 debit  — user's source account loses from-asset
                floatFromId, // $3 credit — system FLOAT gains from-asset
                from_asset_id, // $4
                fromAmt.toFixed(6), // $5
                conversionId, // $6
                JSON.stringify({ direction: "out", rate: rate.toString(), to_asset: to_asset_id }), // $7
            ]);
            // Leg 2 — to-asset "in": FLOAT_to → user
            await client.query(`INSERT INTO ledger_entries
           (idempotency_key, debit_account_id, credit_account_id, asset_id, amount,
            entry_type, reference_id, reference_type, metadata)
         VALUES ($1, $2, $3, $4, $5, 'fx_conversion', $6, 'fx_conversion', $7)`, [
                idempKeyCredit,
                floatToId, // $2 debit  — system FLOAT gives to-asset
                toAcc.id, // $3 credit — user's destination account gains to-asset
                to_asset_id, // $4
                toAmt.toFixed(6), // $5
                conversionId, // $6
                JSON.stringify({ direction: "in", rate: rate.toString(), from_asset: from_asset_id }), // $7
            ]);
            // 6. Update all four affected balances atomically
            await client.query("UPDATE balances SET available = available - $1, updated_at = NOW() WHERE account_id = $2", [fromAmt.toFixed(6), fromAcc.id]);
            await client.query("UPDATE balances SET available = available + $1, updated_at = NOW() WHERE account_id = $2", [fromAmt.toFixed(6), floatFromId]);
            await client.query("UPDATE balances SET available = available - $1, updated_at = NOW() WHERE account_id = $2", [toAmt.toFixed(6), floatToId]);
            await client.query("UPDATE balances SET available = available + $1, updated_at = NOW() WHERE account_id = $2", [toAmt.toFixed(6), toAcc.id]);
            return {
                conversion_id: conversionId,
                from_amount: fromAmt.toFixed(2),
                to_amount: toAmt.toFixed(2),
                rate: rate.toString(),
                from_code: rateRows[0].from_code,
                to_code: rateRows[0].to_code,
            };
        });
        void NotificationService_1.notificationService.create({
            userId,
            type: "fx.converted",
            title: "Currency converted",
            body: `Converted ${result.from_amount} ${result.from_code} → ${result.to_amount} ${result.to_code} (rate: ${result.rate})`,
            metadata: result,
        }).catch(() => { });
        return res.json({ conversion: result });
    }
    catch (err) {
        console.error("POST /convert error:", err);
        return res.status(err.status ?? 500).json({ error: err.message ?? "Conversion failed" });
    }
});
exports.default = router;
//# sourceMappingURL=fx.js.map