"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.streamService = exports.StreamService = void 0;
class StreamService {
    userClients = new Map(); // userId → clients
    adminClients = new Set();
    // ── Registration ──────────────────────────────────────────────────────────
    /**
     * Register a new SSE client connection.
     * Writes the initial SSE headers and starts a heartbeat.
     * Returns a cleanup function to call when the connection closes.
     */
    register(userId, isAdmin, clientId, res) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // nginx: disable response buffering
        res.flushHeaders();
        // Send immediate welcome so the client knows the stream is live
        this._write(res, "connected", { userId, ts: Date.now() });
        // Heartbeat keeps NAT/proxy connections alive
        const heartbeat = setInterval(() => {
            this._write(res, "heartbeat", { ts: Date.now() });
        }, 25_000);
        const client = { id: clientId, res, heartbeat };
        // Add to user bucket
        if (!this.userClients.has(userId)) {
            this.userClients.set(userId, new Set());
        }
        this.userClients.get(userId).add(client);
        // Optionally also track as admin
        if (isAdmin)
            this.adminClients.add(client);
        // Cleanup on client disconnect
        const cleanup = () => {
            clearInterval(heartbeat);
            this.userClients.get(userId)?.delete(client);
            if (this.userClients.get(userId)?.size === 0) {
                this.userClients.delete(userId);
            }
            this.adminClients.delete(client);
        };
        res.on("close", cleanup);
        res.on("error", cleanup);
        res.on("finish", cleanup);
        return cleanup;
    }
    // ── Publishing ────────────────────────────────────────────────────────────
    /** Send an event to a specific user (all their open tabs). */
    publish(userId, event, data) {
        const clients = this.userClients.get(userId);
        if (!clients)
            return;
        for (const client of clients) {
            try {
                this._write(client.res, event, data);
            }
            catch { /* ignore closed */ }
        }
    }
    /** Send an event to all connected admin sessions. */
    publishAdmin(event, data) {
        for (const client of this.adminClients) {
            try {
                this._write(client.res, event, data);
            }
            catch { /* ignore closed */ }
        }
    }
    // ── Internals ─────────────────────────────────────────────────────────────
    _write(res, event, data) {
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        res.write(`event: ${event}\ndata: ${payload}\n\n`);
        // Some Node.js versions need an explicit flush on SSE streams
        if (typeof res.flush === "function")
            res.flush();
    }
}
exports.StreamService = StreamService;
exports.streamService = new StreamService();
//# sourceMappingURL=StreamService.js.map