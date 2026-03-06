import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { notificationService } from "../services/NotificationService";

const router = Router();

// GET /notifications — list user's notifications (paginated)
router.get("/", authenticate, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(String(req.query["limit"]  ?? "50"), 10), 200);
    const offset = parseInt(String(req.query["offset"] ?? "0"), 10);
    const notifications = await notificationService.list(req.user!.sub, limit, offset);
    return res.json({ notifications });
  } catch (err) {
    console.error("GET /notifications error:", err);
    return res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// GET /notifications/unread-count — lightweight badge count
router.get("/unread-count", authenticate, async (req, res) => {
  try {
    const count = await notificationService.unreadCount(req.user!.sub);
    return res.json({ count });
  } catch (err) {
    console.error("GET /notifications/unread-count error:", err);
    return res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// POST /notifications/mark-all-read
router.post("/mark-all-read", authenticate, async (req, res) => {
  try {
    await notificationService.markAllRead(req.user!.sub);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /notifications/mark-all-read error:", err);
    return res.status(500).json({ error: "Failed to mark notifications read" });
  }
});

// POST /notifications/:id/read — mark a single notification as read
router.post("/:id/read", authenticate, async (req, res) => {
  try {
    await notificationService.markRead(req.params["id"]!, req.user!.sub);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /notifications/:id/read error:", err);
    return res.status(500).json({ error: "Failed to mark notification read" });
  }
});

export default router;
