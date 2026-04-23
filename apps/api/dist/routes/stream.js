"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const uuid_1 = require("uuid");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const StreamService_1 = require("../services/StreamService");
const config_1 = require("../config");
const router = (0, express_1.Router)();
// ─────────────────────────────────────────────────────────────────────────────
// Helper: validate JWT from query param `?token=` and return the payload.
// EventSource does not allow custom headers, so we accept the token in the URL.
// Only use over HTTPS in production.
// ─────────────────────────────────────────────────────────────────────────────
function authFromQuery(token) {
    if (!token)
        return null;
    try {
        const payload = jsonwebtoken_1.default.verify(token, config_1.config.jwt.secret);
        return { sub: payload.sub, role: payload.role ?? "user" };
    }
    catch {
        return null;
    }
}
// ── GET /stream  — user SSE stream ───────────────────────────────────────────
router.get("/", (req, res) => {
    const user = authFromQuery(req.query["token"]);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const clientId = (0, uuid_1.v4)();
    StreamService_1.streamService.register(user.sub, user.role === "admin", clientId, res);
    // cleanup is handled internally on res close/error/finish
});
// ── GET /admin-stream  — admin-only SSE stream ───────────────────────────────
router.get("/admin", (req, res) => {
    const user = authFromQuery(req.query["token"]);
    if (!user || user.role !== "admin") {
        res.status(403).json({ error: "Forbidden" });
        return;
    }
    const clientId = (0, uuid_1.v4)();
    StreamService_1.streamService.register(user.sub, true, clientId, res);
});
exports.default = router;
//# sourceMappingURL=stream.js.map