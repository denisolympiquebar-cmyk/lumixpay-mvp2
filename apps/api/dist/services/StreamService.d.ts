import { Response } from "express";
export declare class StreamService {
    private userClients;
    private adminClients;
    /**
     * Register a new SSE client connection.
     * Writes the initial SSE headers and starts a heartbeat.
     * Returns a cleanup function to call when the connection closes.
     */
    register(userId: string, isAdmin: boolean, clientId: string, res: Response): () => void;
    /** Send an event to a specific user (all their open tabs). */
    publish(userId: string, event: string, data: unknown): void;
    /** Send an event to all connected admin sessions. */
    publishAdmin(event: string, data: unknown): void;
    private _write;
}
export declare const streamService: StreamService;
//# sourceMappingURL=StreamService.d.ts.map