"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const NotificationService_1 = require("../services/NotificationService");
const router = (0, express_1.Router)();
// GET /notifications — list user's notifications (paginated)
router.get("/", auth_1.authenticate, async (req, res) => {
    try {
        const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);
        const offset = parseInt(String(req.query["offset"] ?? "0"), 10);
        const notifications = await NotificationService_1.notificationService.list(req.user.sub, limit, offset);
        return res.json({ notifications });
    }
    catch (err) {
        console.error("GET /notifications error:", err);
        return res.status(500).json({ error: "Failed to fetch notifications" });
    }
});
// GET /notifications/unread-count — lightweight badge count
router.get("/unread-count", auth_1.authenticate, async (req, res) => {
    try {
        const count = await NotificationService_1.notificationService.unreadCount(req.user.sub);
        return res.json({ count });
    }
    catch (err) {
        console.error("GET /notifications/unread-count error:", err);
        return res.status(500).json({ error: "Failed to fetch unread count" });
    }
});
// POST /notifications/mark-all-read
router.post("/mark-all-read", auth_1.authenticate, async (req, res) => {
    try {
        await NotificationService_1.notificationService.markAllRead(req.user.sub);
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("POST /notifications/mark-all-read error:", err);
        return res.status(500).json({ error: "Failed to mark notifications read" });
    }
});
// POST /notifications/:id/read — mark a single notification as read
router.post("/:id/read", auth_1.authenticate, async (req, res) => {
    try {
        await NotificationService_1.notificationService.markRead(req.params["id"], req.user.sub);
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("POST /notifications/:id/read error:", err);
        return res.status(500).json({ error: "Failed to mark notification read" });
    }
});
exports.default = router;
//# sourceMappingURL=notifications.js.map