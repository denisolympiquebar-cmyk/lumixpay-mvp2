import { useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// useStream — SSE client with exponential-backoff reconnect.
//
// EventSource doesn't support custom headers, so the JWT token is passed as a
// query parameter (?token=...).  This is acceptable for an MVP / localhost
// but should be replaced with a short-lived /auth/sse-token approach in prod.
//
// Usage:
//   useStream(token, {
//     "balances.updated":      (data) => { ... },
//     "notifications.unread":  (data) => { ... },
//     "activity.new":          (data) => { ... },
//   });
// ─────────────────────────────────────────────────────────────────────────────

type Handler = (data: any) => void;

// In dev: VITE_API_BASE is unset → empty string → relative URL "/stream?token=..."
//          Vite proxies /stream → http://localhost:4000/stream
// In prod: VITE_API_BASE=https://lumixpay-api.fly.dev → full absolute SSE URL
const BASE_URL = import.meta.env.VITE_API_BASE ?? "";

const MIN_BACKOFF  =  1_000;
const MAX_BACKOFF  = 30_000;

export function useStream(
  token: string | null | undefined,
  handlers: Record<string, Handler>
): void {
  const handlersRef = useRef<Record<string, Handler>>(handlers);
  handlersRef.current = handlers; // always up-to-date without re-subscribing

  useEffect(() => {
    if (!token) return;

    let es: EventSource | null = null;
    let backoff  = MIN_BACKOFF;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const connect = () => {
      if (destroyed) return;

      const url = `${BASE_URL}/stream?token=${encodeURIComponent(token)}`;
      es = new EventSource(url);

      es.onopen = () => {
        backoff = MIN_BACKOFF; // reset on successful connect
      };

      es.onerror = () => {
        es?.close();
        es = null;
        if (destroyed) return;
        retryTimer = setTimeout(() => {
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          connect();
        }, backoff);
      };

      // Route named events to registered handlers
      const allEvents = [
        "connected", "heartbeat",
        "balances.updated", "notifications.unread", "activity.new",
        "admin.alerts.updated", "admin.withdrawals.updated",
        "admin.treasury.updated", "admin.ledger.new",
      ];

      for (const evt of allEvents) {
        es.addEventListener(evt, (e: MessageEvent) => {
          const handler = handlersRef.current[evt];
          if (!handler) return;
          try {
            handler(JSON.parse(e.data));
          } catch {
            handler(e.data);
          }
        });
      }
    };

    connect();

    return () => {
      destroyed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [token]); // reconnect only when token changes
}
