import { pool } from "../db/pool";

type AlertSeverity = "info" | "warning" | "critical";

function keyToStableHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h << 5) - h + input.charCodeAt(i);
  return Math.abs(h);
}

/**
 * Fire-and-forget helper for operational risk alerts.
 * Includes coarse dedupe/cooldown to reduce noisy duplicate alerts.
 */
export class AdminAlertService {
  async emit(params: {
    type: string;
    title: string;
    body?: string;
    severity: AlertSeverity;
    metadata?: Record<string, unknown>;
    dedupeKey?: string;
    dedupeMinutes?: number;
  }): Promise<void> {
    const {
      type,
      title,
      body,
      severity,
      metadata,
      dedupeKey,
      dedupeMinutes = 30,
    } = params;

    try {
      if (dedupeKey) {
        const hash = keyToStableHash(`${type}:${dedupeKey}`);
        const { rows } = await pool.query<{ id: string }>(
          `SELECT id
             FROM admin_alerts
            WHERE type = $1
              AND metadata->>'dedupe_hash' = $2
              AND created_at >= NOW() - ($3::text || ' minutes')::interval
            LIMIT 1`,
          [type, String(hash), String(dedupeMinutes)]
        );
        if (rows[0]) return;
      }

      await pool.query(
        `INSERT INTO admin_alerts (type, title, body, metadata, severity)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          type,
          title,
          body ?? null,
          JSON.stringify({
            ...(metadata ?? {}),
            ...(dedupeKey ? { dedupe_hash: String(keyToStableHash(`${type}:${dedupeKey}`)) } : {}),
          }),
          severity,
        ]
      );
    } catch (err) {
      console.error("[AdminAlertService] emit failed:", err);
    }
  }
}

export const adminAlertService = new AdminAlertService();

