import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { ledgerService } from "../services/LedgerService";

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
router.get("/me/accounts/:accountId/history", authenticate, async (req, res) => {
  const { accountId } = req.params;
  const limit  = Math.min(parseInt(String(req.query["limit"]  ?? "50"), 10), 200);
  const offset = parseInt(String(req.query["offset"] ?? "0"), 10);

  try {
    const entries = await ledgerService.getLedgerHistory(accountId, limit, offset);
    return res.json({ entries });
  } catch (err) {
    console.error("ledger history error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
