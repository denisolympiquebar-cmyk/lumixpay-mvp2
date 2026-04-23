import { Pool, PoolClient } from "pg";
export declare const pool: Pool;
/**
 * Executes `fn` inside a single PostgreSQL transaction.
 * Commits on success, rolls back on any thrown error.
 */
export declare function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
//# sourceMappingURL=pool.d.ts.map