// Shared types between API and Web

export type UserRole = "user" | "admin" | "system";

export type EntryType =
  | "topup"
  | "transfer"
  | "fee"
  | "withdrawal_lock"
  | "withdrawal_unlock"
  | "withdrawal_settle";

export type WithdrawalStatus = "pending" | "approved" | "rejected" | "settled";

export interface ApiUser {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  /** Present on profile; optional XRPL Testnet link (verified). */
  xrpl_address?: string | null;
  xrpl_network?: string | null;
  xrpl_verified_at?: string | null;
}

export interface ApiAsset {
  currency_code: string;
  display_name: string;
  display_symbol: string;
}

export interface ApiAccountBalance {
  id: string;
  asset_id: string;
  label: string;
  asset: ApiAsset;
  balance: {
    available: string;
    locked: string;
  };
}

export interface ApiLedgerEntry {
  id: string;
  entry_type: EntryType;
  amount: string;
  debit_account_id: string;
  credit_account_id: string;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface ApiWithdrawal {
  id: string;
  asset_id: string;
  gross_amount: string;
  fee_amount: string;
  net_amount: string;
  xrpl_destination_address: string;
  xrpl_destination_tag: number | null;
  status: WithdrawalStatus;
  created_at: string;
}

export const ALLOWED_TOPUP_AMOUNTS = [10, 20, 50, 100] as const;
export type AllowedTopupAmount = (typeof ALLOWED_TOPUP_AMOUNTS)[number];
