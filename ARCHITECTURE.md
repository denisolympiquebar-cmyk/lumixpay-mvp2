# LumixPay Architecture

LumixPay is a ledger-first stablecoin payment infrastructure.

Core principles:
- PostgreSQL internal ledger is the source of truth
- XRPL is settlement rail only
- Supported assets:
  - RLUSD (USD)
  - EURQ (EUR)
- 1% platform fee on every transaction
- Web3 interaction happens ONLY on withdrawal

MVP Features:
- Simulated card top-up (10/20/50/100)
- Internal transfers
- Admin approval withdrawals
- API infrastructure
- PWA installable web app

Next Phase:
Phase 1 — Database migrations + LedgerService.
