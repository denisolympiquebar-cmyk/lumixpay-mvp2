"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Simple sequential SQL migration runner.
 * Reads *.sql files from ./migrations/, tracks applied migrations in
 * `schema_migrations`, and runs new ones in filename order.
 */
require("dotenv/config");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const pool_1 = require("./pool");
console.log("CWD:", process.cwd());
console.log("DATABASE_URL env:", process.env.DATABASE_URL);
console.log("CONFIG DB:", require("../config").config.db.connectionString);
const MIGRATIONS_DIR = path_1.default.join(__dirname, "migrations");
async function migrate() {
    const client = await pool_1.pool.connect();
    try {
        await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         SERIAL      PRIMARY KEY,
        filename   VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
        const { rows: applied } = await client.query("SELECT filename FROM schema_migrations ORDER BY filename");
        const appliedSet = new Set(applied.map((r) => r.filename));
        const files = fs_1.default
            .readdirSync(MIGRATIONS_DIR)
            .filter((f) => f.endsWith(".sql"))
            .sort();
        for (const file of files) {
            if (appliedSet.has(file)) {
                console.log(`  skip  ${file}`);
                continue;
            }
            const sql = fs_1.default.readFileSync(path_1.default.join(MIGRATIONS_DIR, file), "utf8");
            await client.query("BEGIN");
            try {
                await client.query(sql);
                await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
                await client.query("COMMIT");
                console.log(`  apply ${file}`);
            }
            catch (err) {
                await client.query("ROLLBACK");
                console.error(`  FAIL  ${file}:`, err);
                throw err;
            }
        }
        console.log("Migrations complete.");
    }
    finally {
        client.release();
        await pool_1.pool.end();
    }
}
migrate().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map