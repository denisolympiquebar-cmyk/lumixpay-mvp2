"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.correlationId = correlationId;
const crypto_1 = __importDefault(require("crypto"));
function newCorrelationId() {
    if (typeof crypto_1.default.randomUUID === "function")
        return crypto_1.default.randomUUID();
    return crypto_1.default.randomBytes(16).toString("hex");
}
function correlationId(req, res, next) {
    const incoming = req.header("x-correlation-id")?.trim();
    const id = incoming && incoming.length > 0 ? incoming.slice(0, 120) : newCorrelationId();
    req.correlationId = id;
    res.setHeader("x-correlation-id", id);
    next();
}
//# sourceMappingURL=correlation.js.map