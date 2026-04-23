type AlertSeverity = "info" | "warning" | "critical";
/**
 * Fire-and-forget helper for operational risk alerts.
 * Includes coarse dedupe/cooldown to reduce noisy duplicate alerts.
 */
export declare class AdminAlertService {
    emit(params: {
        type: string;
        title: string;
        body?: string;
        severity: AlertSeverity;
        metadata?: Record<string, unknown>;
        dedupeKey?: string;
        dedupeMinutes?: number;
    }): Promise<void>;
}
export declare const adminAlertService: AdminAlertService;
export {};
//# sourceMappingURL=AdminAlertService.d.ts.map