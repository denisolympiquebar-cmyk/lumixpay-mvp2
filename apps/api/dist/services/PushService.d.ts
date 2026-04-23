export interface PushPayload {
    title: string;
    body?: string;
    type?: string;
    url?: string;
}
export declare class PushService {
    /**
     * Send a push notification to every registered device for `userId`.
     * Invalid / expired subscriptions (HTTP 404 / 410) are silently deleted.
     * Never throws — failures are fire-and-forget.
     */
    sendToUser(userId: string, payload: PushPayload): Promise<void>;
}
export declare const pushService: PushService;
//# sourceMappingURL=PushService.d.ts.map