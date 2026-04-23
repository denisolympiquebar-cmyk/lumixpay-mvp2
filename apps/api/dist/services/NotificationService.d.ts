export type NotificationType = "topup.completed" | "transfer.sent" | "transfer.received" | "withdrawal.requested" | "withdrawal.approved" | "withdrawal.rejected" | "withdrawal.settled" | "voucher.redeemed" | "voucher.purchased" | "payment_link.paid" | "recurring.executed" | "fx.converted";
export interface Notification {
    id: string;
    user_id: string;
    type: string;
    title: string;
    body: string | null;
    metadata: Record<string, unknown> | null;
    is_read: boolean;
    created_at: Date;
}
export interface CreateNotificationParams {
    userId: string;
    type: NotificationType;
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
}
export declare class NotificationService {
    create(params: CreateNotificationParams): Promise<Notification>;
    list(userId: string, limit?: number, offset?: number): Promise<Notification[]>;
    unreadCount(userId: string): Promise<number>;
    markRead(notificationId: string, userId: string): Promise<void>;
    markAllRead(userId: string): Promise<void>;
}
export declare const notificationService: NotificationService;
//# sourceMappingURL=NotificationService.d.ts.map