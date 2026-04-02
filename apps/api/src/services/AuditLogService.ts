import { pool } from "../db/pool";

export class AuditLogService {
  async log(params: {
    actorUserId?: string | null;
    actionType: string;
    entityType: string;
    entityId?: string | null;
    correlationId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const {
      actorUserId = null,
      actionType,
      entityType,
      entityId = null,
      correlationId = null,
      metadata = {},
    } = params;

    try {
      await pool.query(
        `INSERT INTO audit_logs
          (actor_user_id, action_type, entity_type, entity_id, correlation_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          actorUserId,
          actionType,
          entityType,
          entityId,
          correlationId,
          JSON.stringify(metadata),
        ]
      );
    } catch (err) {
      console.error("[AuditLogService] log failed:", err);
    }
  }
}

export const auditLogService = new AuditLogService();

