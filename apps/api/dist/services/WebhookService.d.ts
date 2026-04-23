export declare const ALL_WEBHOOK_EVENTS: readonly ["topup.completed", "transfer.sent", "transfer.received", "withdrawal.requested", "withdrawal.approved", "withdrawal.rejected", "withdrawal.settled", "voucher.redeemed", "payment_link.paid", "subscription.charged", "webhook.failed"];
export type WebhookEventType = (typeof ALL_WEBHOOK_EVENTS)[number];
export declare class WebhookService {
    /**
     * Dispatch an event to all active webhooks subscribed to it for a given user.
     * Delivery is fire-and-forget; failures are logged and stored for retries.
     */
    dispatch(userId: string, eventType: string, payload: Record<string, unknown>): Promise<void>;
    private deliver;
    private scheduleRetry;
}
export declare const webhookService: WebhookService;
//# sourceMappingURL=WebhookService.d.ts.map