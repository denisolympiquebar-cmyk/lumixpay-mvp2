import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import { streamService } from "../services/StreamService";
import { config } from "../config";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: validate JWT from query param `?token=` and return the payload.
// EventSource does not allow custom headers, so we accept the token in the URL.
// Only use over HTTPS in production.
// ─────────────────────────────────────────────────────────────────────────────

function authFromQuery(token: string | undefined): { sub: string; role: string } | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwt.secret) as any;
    return { sub: payload.sub, role: payload.role ?? "user" };
  } catch {
    return null;
  }
}

// ── GET /stream  — user SSE stream ───────────────────────────────────────────

router.get("/", (req, res) => {
  const user = authFromQuery(req.query["token"] as string | undefined);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const clientId = uuidv4();
  streamService.register(user.sub, user.role === "admin", clientId, res);
  // cleanup is handled internally on res close/error/finish
});

// ── GET /admin-stream  — admin-only SSE stream ───────────────────────────────

router.get("/admin", (req, res) => {
  const user = authFromQuery(req.query["token"] as string | undefined);
  if (!user || user.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const clientId = uuidv4();
  streamService.register(user.sub, true, clientId, res);
});

export default router;
