export type UserRole = "user" | "admin" | "system";
export type EntryType = "topup" | "transfer" | "fee" | "withdrawal_lock" | "withdrawal_unlock" | "withdrawal_settle" | "voucher" | "payment_link" | "recurring" | "fx_conversion";
export type TopupStatus = "pending" | "completed" | "failed";
export type TransferStatus = "pending" | "completed" | "failed";
export type WithdrawalStatus = "pending" | "approved" | "rejected" | "settled";
export interface Asset {
    id: string;
    currency_code: string;
    issuer_address: string;
    decimals: number;
    display_name: string;
    display_symbol: string;
    is_active: boolean;
    created_at: Date;
}
export interface User {
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    role: UserRole;
    username: string | null;
    is_frozen: boolean;
    created_at: Date;
    /** Optional linked XRPL classic address (verified). */
    xrpl_address?: string | null;
    xrpl_network?: string | null;
    xrpl_verified_at?: Date | null;
}
export interface VoucherProduct {
    id: string;
    asset_id: string;
    amount: string;
    is_active: boolean;
    created_at: Date;
}
export interface FxRate {
    id: string;
    base_asset: string;
    quote_asset: string;
    rate: string;
    updated_at: Date;
}
export interface TreasuryLimit {
    asset_id: string;
    max_supply: string;
    current_supply: string;
    updated_at: Date;
}
export interface Account {
    id: string;
    user_id: string;
    asset_id: string;
    label: string;
    created_at: Date;
}
export interface Balance {
    id: string;
    account_id: string;
    available: string;
    locked: string;
    updated_at: Date;
}
export interface LedgerEntry {
    id: string;
    idempotency_key: string;
    debit_account_id: string;
    credit_account_id: string;
    asset_id: string;
    amount: string;
    entry_type: EntryType;
    reference_id: string | null;
    reference_type: string | null;
    metadata: Record<string, unknown> | null;
    created_at: Date;
}
export interface TopupTransaction {
    id: string;
    user_id: string;
    account_id: string;
    asset_id: string;
    gross_amount: string;
    fee_amount: string;
    net_amount: string;
    provider: string;
    provider_reference: string | null;
    simulated_card_last4: string | null;
    status: TopupStatus;
    created_at: Date;
    updated_at: Date;
}
export interface Transfer {
    id: string;
    from_account_id: string;
    to_account_id: string;
    asset_id: string;
    gross_amount: string;
    fee_amount: string;
    net_amount: string;
    status: TransferStatus;
    created_at: Date;
}
export interface WithdrawalRequest {
    id: string;
    user_id: string;
    account_id: string;
    asset_id: string;
    gross_amount: string;
    fee_amount: string;
    net_amount: string;
    xrpl_destination_address: string;
    xrpl_destination_tag: number | null;
    status: WithdrawalStatus;
    reviewed_by: string | null;
    reviewed_at: Date | null;
    admin_note: string | null;
    xrpl_tx_hash: string | null;
    created_at: Date;
    updated_at: Date;
    settlement_provider: string | null;
    xrpl_submitted_at: Date | null;
    xrpl_confirmed_at: Date | null;
    xrpl_network_fee_xrp: string | null;
}
export interface AccountWithBalance extends Account {
    asset: Pick<Asset, "currency_code" | "display_name" | "display_symbol">;
    balance: Pick<Balance, "available" | "locked">;
}
export interface JwtPayload {
    sub: string;
    email: string;
    role: UserRole;
    iat?: number;
    exp?: number;
}
export interface Contact {
    id: string;
    owner_user_id: string;
    contact_user_id: string;
    nickname: string | null;
    created_at: Date;
}
export type PaymentLinkStatus = "active" | "disabled";
export interface PaymentLink {
    id: string;
    creator_user_id: string;
    asset_id: string;
    amount: string | null;
    description: string | null;
    status: PaymentLinkStatus;
    max_uses: number | null;
    uses_count: number;
    expires_at: Date | null;
    created_at: Date;
}
export type VoucherStatus = "active" | "redeemed" | "disabled";
export interface Voucher {
    id: string;
    code: string;
    asset_id: string;
    gross_amount: string;
    status: VoucherStatus;
    /** NULL for user-purchased vouchers (see migration 016). */
    created_by_admin_id: string | null;
    /** NULL for admin-gifted vouchers. Set when a user buys via /vouchers/purchase. */
    purchased_by_user_id: string | null;
    redeemed_by_user_id: string | null;
    redeemed_at: Date | null;
    expires_at: Date | null;
    created_at: Date;
}
export type RecurringInterval = "weekly" | "monthly";
export type RecurringPlanStatus = "active" | "paused" | "deleted";
export type SubscriptionStatus = "active" | "canceled";
export interface RecurringPlan {
    id: string;
    creator_user_id: string;
    asset_id: string;
    amount: string;
    interval: RecurringInterval;
    day_of_week: number | null;
    day_of_month: number | null;
    status: RecurringPlanStatus;
    description: string | null;
    created_at: Date;
}
export interface Subscription {
    id: string;
    plan_id: string;
    subscriber_user_id: string;
    status: SubscriptionStatus;
    next_run_at: Date;
    created_at: Date;
}
export interface ApiKey {
    id: string;
    user_id: string;
    name: string;
    key_hash: string;
    last4: string;
    created_at: Date;
    revoked_at: Date | null;
}
export type WebhookStatus = "active" | "disabled";
export interface Webhook {
    id: string;
    user_id: string;
    url: string;
    secret: string;
    events: string[];
    status: WebhookStatus;
    created_at: Date;
}
export type DeliveryStatus = "pending" | "delivered" | "failed";
export interface WebhookDelivery {
    id: string;
    webhook_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    status: DeliveryStatus;
    attempts: number;
    last_error: string | null;
    delivered_at: Date | null;
    created_at: Date;
}
export type AlertSeverity = "info" | "warning" | "critical";
export interface AdminAlert {
    id: string;
    type: string;
    title: string;
    body: string | null;
    metadata: Record<string, unknown> | null;
    severity: AlertSeverity;
    is_resolved: boolean;
    created_at: Date;
}
//# sourceMappingURL=types.d.ts.map