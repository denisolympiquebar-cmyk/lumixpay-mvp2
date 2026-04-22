import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import Decimal from "decimal.js";
import { authenticate, requireRole } from "../middleware/auth";
import { requireNotFrozen } from "../middleware/frozen";
import { idempotent } from "../middleware/idempotency";
import { requireIdempotencyKey } from "../middleware/require-idempotency";
import { pool, withTransaction } from "../db/pool";
import { Voucher, Account } from "../db/types";
import { ledgerService } from "../services/LedgerService";
import { notificationService } from "../services/NotificationService";
import { treasuryService } from "../services/TreasuryService";
import { config } from "../config";

const router = Router();

// ── Admin endpoints ───────────────────────────────────────────────────────────

const CreateVoucherSchema = z.object({
  asset_id: z.string().uuid(),
  gross_amount: z.number().positive(),
  expires_at: z.string().datetime().optional(),
});

// POST /admin/vouchers  — admin creates a voucher
router.post("/admin", authenticate, requireRole("admin"), async (req, res) => {
  const parsed = CreateVoucherSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { asset_id, gross_amount, expires_at } = parsed.data;

  // Secure random code: 8 uppercase hex chars (32-bit entropy)
  const code = crypto.randomBytes(4).toString("hex").toUpperCase();

  try {
    const { rows } = await pool.query<Voucher>(
      `INSERT INTO vouchers (code, asset_id, gross_amount, created_by_admin_id, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [code, asset_id, gross_amount, req.user!.sub, expires_at ?? null]
    );
    return res.status(201).json({ voucher: rows[0] });
  } catch (err) {
    console.error("POST /admin/vouchers error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/vouchers
router.get("/admin", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*, a.currency_code, a.display_symbol
         FROM vouchers v
         JOIN assets a ON a.id = v.asset_id
        ORDER BY v.created_at DESC`
    );
    return res.json({ vouchers: rows });
  } catch (err) {
    console.error("GET /admin/vouchers error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/vouchers/:id/disable
router.post("/admin/:id/disable", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE vouchers SET status = 'disabled' WHERE id = $1 AND status = 'active'",
      [req.params["id"]]
    );
    if (!rowCount) return res.status(404).json({ error: "Active voucher not found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/vouchers/:id/disable error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── Admin: Voucher product catalog management ─────────────────────────────────

const CreateProductSchema = z.object({
  asset_id:  z.string().uuid(),
  amount:    z.number().positive(),
});

// GET /vouchers/admin/products — list all products (active + inactive)
router.get("/admin/products", authenticate, requireRole("admin"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT vp.*, a.currency_code, a.display_symbol, a.display_name
         FROM voucher_products vp
         JOIN assets a ON a.id = vp.asset_id
        ORDER BY a.currency_code, vp.amount`
    );
    return res.json({ products: rows });
  } catch (err) {
    console.error("GET /vouchers/admin/products error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /vouchers/admin/products — create a new purchasable product
router.post("/admin/products", authenticate, requireRole("admin"), async (req, res) => {
  const parsed = CreateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { asset_id, amount } = parsed.data;
  try {
    const { rows } = await pool.query(
      `INSERT INTO voucher_products (asset_id, amount, is_active)
       VALUES ($1, $2, TRUE) RETURNING *`,
      [asset_id, new Decimal(amount).toFixed(6)]
    );
    return res.status(201).json({ product: rows[0] });
  } catch (err) {
    console.error("POST /vouchers/admin/products error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /vouchers/admin/products/:id/toggle — activate or deactivate a product
router.patch("/admin/products/:id/toggle", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE voucher_products
          SET is_active = NOT is_active
        WHERE id = $1
        RETURNING *`,
      [req.params["id"]]
    );
    if (!rowCount) return res.status(404).json({ error: "Product not found" });
    return res.json({ product: rows[0] });
  } catch (err) {
    console.error("PATCH /vouchers/admin/products/:id/toggle error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── User endpoint ─────────────────────────────────────────────────────────────

const RedeemSchema = z.object({ code: z.string().min(1) });

// POST /vouchers/redeem
router.post("/redeem", authenticate, requireNotFrozen, requireIdempotencyKey, idempotent, async (req, res) => {
  const parsed = RedeemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { code } = parsed.data;
  const userId = req.user!.sub;

  try {
    const result = await withTransaction(async (client) => {
      // Lock the voucher row
      const { rows: vRows } = await client.query<Voucher>(
        "SELECT * FROM vouchers WHERE code = $1 FOR UPDATE",
        [code.toUpperCase()]
      );
      const voucher = vRows[0];
      if (!voucher) throw Object.assign(new Error("Voucher not found"), { status: 404 });
      if (voucher.status === "redeemed") throw Object.assign(new Error("Voucher already redeemed"), { status: 409 });
      if (voucher.status === "disabled") throw Object.assign(new Error("Voucher is disabled"), { status: 410 });
      if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
        throw Object.assign(new Error("Voucher has expired"), { status: 410 });
      }

      // Resolve user's main account for this asset
      const { rows: accRows } = await client.query<Account>(
        "SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'",
        [userId, voucher.asset_id]
      );
      if (!accRows[0]) throw Object.assign(new Error("No account for this asset"), { status: 422 });

      // Resolve FLOAT account for the asset
      const sysAccounts = config.system.accounts;
      const isRlusd = voucher.asset_id === sysAccounts.rlusd.assetId;
      const floatAccountId = isRlusd ? sysAccounts.rlusd.float : sysAccounts.eurq.float;

      const gross = new Decimal(voucher.gross_amount);
      const idempKey = `voucher:${voucher.id}:${userId}`;

      // Treasury gate: only admin-created vouchers mint new supply.
      // User-purchased vouchers (purchased_by_user_id IS NOT NULL) don't mint
      // because the buyer already paid from circulating balance.
      const isAdminVoucher =
        voucher.created_by_admin_id != null && !("purchased_by_user_id" in voucher && (voucher as any).purchased_by_user_id);
      if (isAdminVoucher) {
        await treasuryService.ensureCanIssue(client, voucher.asset_id, gross);
      }

      // Post ledger entry: FLOAT → user (full gross, no fee for voucher)
      await client.query(
        `INSERT INTO ledger_entries
           (idempotency_key, debit_account_id, credit_account_id, asset_id, amount, entry_type, reference_id, reference_type)
         VALUES ($1,$2,$3,$4,$5,'voucher',$6,'voucher')`,
        [idempKey, floatAccountId, accRows[0].id, voucher.asset_id, gross.toFixed(6), voucher.id]
      );

      // Update balances: FLOAT.available -= gross, user.available += gross
      await client.query(
        "UPDATE balances SET available = available - $1, updated_at = NOW() WHERE account_id = $2",
        [gross.toFixed(6), floatAccountId]
      );
      await client.query(
        "UPDATE balances SET available = available + $1, updated_at = NOW() WHERE account_id = $2",
        [gross.toFixed(6), accRows[0].id]
      );

      // Record treasury issuance for admin-created vouchers
      if (isAdminVoucher) {
        await treasuryService.issue(client, voucher.asset_id, gross);
      }

      // Mark voucher redeemed
      await client.query(
        "UPDATE vouchers SET status = 'redeemed', redeemed_by_user_id = $1, redeemed_at = NOW() WHERE id = $2",
        [userId, voucher.id]
      );

      return { voucher, credited: gross.toFixed(2) };
    });

    void notificationService.create({
      userId,
      type: "voucher.redeemed",
      title: "Voucher redeemed",
      body: `${result.credited} credited to your account`,
      metadata: { voucher_id: result.voucher.id, amount: result.credited },
    }).catch(() => {});

    return res.json({ ok: true, credited: result.credited });
  } catch (err: any) {
    console.error("POST /vouchers/redeem error:", err);
    return res.status(err.status ?? 500).json({ error: err.message ?? "Redemption failed" });
  }
});

export default router;
