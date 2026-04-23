/**
 * Processes subscriptions whose next_run_at <= now.
 * Called every 60 seconds from the API startup loop.
 * Each run is idempotent: the transfer's idempotency key encodes
 * subscription_id + next_run_at so double-charges are impossible.
 */
export declare function processRecurring(): Promise<void>;
export declare function startRecurringJob(): void;
//# sourceMappingURL=RecurringService.d.ts.map