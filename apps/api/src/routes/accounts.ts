import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { ledgerService } from "../services/LedgerService";
import { pool } from "../db/pool";

const router = Router();

// GET /me/accounts — list all user accounts with live balances
router.get("/me/accounts", authenticate, async (req, res) => {
  try {
    const accounts = await ledgerService.getAccountsWithBalances(req.user!.sub);
    return res.json({ accounts });
  } catch (err) {
    console.error("get accounts error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /me/accounts/:accountId/history — ledger history for one account
//
// Transfer entries are enriched with a `counterparty` field:
//   { id: string, username: string | null }
// The counterparty is the other side of the transfer (sender if you received,
// recipient if you sent). All other entry types have no counterparty field.
//
// Old entries without a resolved counterparty receive counterparty: null.
// This is additive and does not break existing consumers.
router.get("/me/accounts/:accountId/history", authenticate, async (req, res) => {
  const { accountId } = req.params;
  const limit  = Math.min(parseInt(String(req.query["limit"]  ?? "50"), 10), 200);
  const offset = parseInt(String(req.query["offset"] ?? "0"), 10);

  try {
    const rawEntries = await ledgerService.getLedgerHistory(accountId, limit, offset);

    // ── Batch-enrich transfer entries with counterparty identity ──────────────
    const transferEntries = rawEntries.filter((e) => e.entry_type === "transfer");
    const counterpartyMap = new Map<string, { id: string; username: string | null }>();

    if (transferEntries.length > 0) {
      // The "counterparty" account is whichever side of the entry is not the requested accountId.
      const counterpartyAccountIds = [
        ...new Set(
          transferEntries.map((e) =>
            e.credit_account_id === accountId ? e.debit_account_id : e.credit_account_id,
          ),
        ),
      ];

      const { rows } = await pool.query<{
        account_id: string;
        user_id: string;
        username: string | null;
      }>(
        `SELECT a.id AS account_id, u.id AS user_id, u.username
           FROM accounts a
           JOIN users u ON u.id = a.user_id
          WHERE a.id = ANY($1::uuid[])`,
        [counterpartyAccountIds],
      );

      for (const row of rows) {
        counterpartyMap.set(row.account_id, { id: row.user_id, username: row.username });
      }
    }

    const entries = rawEntries.map((e) => {
      if (e.entry_type !== "transfer") return e;
      const counterpartyAccountId =
        e.credit_account_id === accountId ? e.debit_account_id : e.credit_account_id;
      const counterparty = counterpartyMap.get(counterpartyAccountId) ?? null;
      return { ...e, counterparty };
    });

    return res.json({ entries });
  } catch (err) {
    console.error("ledger history error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
