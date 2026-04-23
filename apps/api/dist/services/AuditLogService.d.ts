export declare class AuditLogService {
    log(params: {
        actorUserId?: string | null;
        actionType: string;
        entityType: string;
        entityId?: string | null;
        correlationId?: string | null;
        metadata?: Record<string, unknown>;
    }): Promise<void>;
}
export declare const auditLogService: AuditLogService;
//# sourceMappingURL=AuditLogService.d.ts.map