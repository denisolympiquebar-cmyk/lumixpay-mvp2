Current status:

Architecture finalized.
XRPL role defined.
Ledger-first system confirmed.
Stablecoins: RLUSD + EURQ.
Simulated card top-up planned.

Phase 1 — IN PROGRESS (code generated, not yet installed/tested):
- Monorepo scaffold (npm workspaces, docker-compose, .env.example)
- DB migrations: 001_schema.sql (8 tables) + 002_seed_system.sql
- LedgerService: postEntry, topUp, transfer, requestWithdrawal, reviewWithdrawal
- FeeService: 1% with decimal.js
- MockPaymentProvider: always-succeeds stub, enforces 10/20/50/100 denominations
- Express API: auth, accounts, topup, transfers, withdrawals + admin review
- React + Vite PWA shell

Next step:
npm install → npm run db:migrate → npm run dev:api
Then Phase 2: XRPL withdrawal settlement.
