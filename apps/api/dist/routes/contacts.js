"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
const AddContactSchema = zod_1.z.object({
    identifier: zod_1.z.string().min(1), // email or username
    nickname: zod_1.z.string().max(100).optional(),
});
// GET /contacts
router.get("/", auth_1.authenticate, async (req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`SELECT c.id, c.nickname, c.created_at,
              u.id AS contact_id, u.email AS contact_email,
              u.full_name AS contact_full_name, u.username AS contact_username
         FROM contacts c
         JOIN users u ON u.id = c.contact_user_id
        WHERE c.owner_user_id = $1
        ORDER BY c.created_at DESC`, [req.user.sub]);
        return res.json({ contacts: rows });
    }
    catch (err) {
        console.error("GET /contacts error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// POST /contacts
router.post("/", auth_1.authenticate, async (req, res) => {
    const parsed = AddContactSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { identifier, nickname } = parsed.data;
    try {
        // Resolve contact by email or username
        const { rows: userRows } = await pool_1.pool.query("SELECT id, email, full_name, username FROM users WHERE (email = $1 OR username = $1) AND role != 'system'", [identifier]);
        if (!userRows[0]) {
            return res.status(404).json({ error: "User not found with that email or username" });
        }
        const contactUser = userRows[0];
        if (contactUser.id === req.user.sub) {
            return res.status(400).json({ error: "Cannot add yourself as a contact" });
        }
        const { rows } = await pool_1.pool.query(`INSERT INTO contacts (owner_user_id, contact_user_id, nickname)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_user_id, contact_user_id) DO UPDATE SET nickname = EXCLUDED.nickname
       RETURNING *`, [req.user.sub, contactUser.id, nickname ?? null]);
        return res.status(201).json({ contact: rows[0] });
    }
    catch (err) {
        console.error("POST /contacts error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// DELETE /contacts/:id
router.delete("/:id", auth_1.authenticate, async (req, res) => {
    try {
        const { rowCount } = await pool_1.pool.query("DELETE FROM contacts WHERE id = $1 AND owner_user_id = $2", [req.params["id"], req.user.sub]);
        if (!rowCount)
            return res.status(404).json({ error: "Contact not found" });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("DELETE /contacts/:id error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
exports.default = router;
//# sourceMappingURL=contacts.js.map