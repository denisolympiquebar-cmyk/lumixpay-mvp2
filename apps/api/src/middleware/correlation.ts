import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

function newCorrelationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-correlation-id")?.trim();
  const id = incoming && incoming.length > 0 ? incoming.slice(0, 120) : newCorrelationId();
  req.correlationId = id;
  res.setHeader("x-correlation-id", id);
  next();
}

