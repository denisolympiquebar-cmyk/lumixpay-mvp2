"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// SettlementProvider — public contract for all settlement backends.
//
// Phase 1:  MockSettlementProvider (always confirms, no network calls)
// Phase 2:  XrplSettlementService (real XRPL payment, awaits ledger validation)
//
// Nothing outside the xrpl/ module should import XRPL-specific types directly.
// All callers (LedgerService) depend only on this interface.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=SettlementProvider.js.map