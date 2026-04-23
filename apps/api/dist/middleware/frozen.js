"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireNotFrozen = requireNotFrozen;
const pool_1 = require("../db/pool");
/**
 * Middleware: reject the request if the authenticated user's account is frozen.
 * Must be placed after `authenticate`.
 */
async function requireNotFrozen(req, res, next) {
    try {
        const { rows } = await pool_1.pool.query("SELECT is_frozen FROM users WHERE id = $1", [req.user.sub]);
        if (rows[0]?.is_frozen) {
            res.status(403).json({ error: "Account is frozen. Contact support to resolve." });
            return;
        }
        next();
    }
    catch (err) {
        console.error("requireNotFrozen error:", err);
        next(err);
    }
}
//# sourceMappingURL=frozen.js.map