"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogService = exports.AuditLogService = void 0;
const pool_1 = require("../db/pool");
class AuditLogService {
    async log(params) {
        const { actorUserId = null, actionType, entityType, entityId = null, correlationId = null, metadata = {}, } = params;
        try {
            await pool_1.pool.query(`INSERT INTO audit_logs
          (actor_user_id, action_type, entity_type, entity_id, correlation_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`, [
                actorUserId,
                actionType,
                entityType,
                entityId,
                correlationId,
                JSON.stringify(metadata),
            ]);
        }
        catch (err) {
            console.error("[AuditLogService] log failed:", err);
        }
    }
}
exports.AuditLogService = AuditLogService;
exports.auditLogService = new AuditLogService();
//# sourceMappingURL=AuditLogService.js.map