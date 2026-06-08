import http from "http";
import https from "https";

// ─────────────────────────────────────────────────────────────────────────────
// xrplRpc.ts — shared low-level XRPL Testnet utilities (Phase 4A cleanup)
//
// This module consolidates the five helpers that were duplicated across
// every XRPL service file in this codebase:
//
//   postJson          — raw HTTP/HTTPS JSON-RPC transport (no auth)
//   sleep             — Promise-based timeout
//   isXrplTransientError — predicate for retryable network errors
//   withRetry         — generic retry loop with configurable backoff
//   assertTestnetRpc  — SAFETY GUARD: rejects non-testnet RPC URLs
//
// ── WHY ISOLATED COPIES WERE ACCEPTABLE DURING DEVELOPMENT ──────────────────
//   Each service was self-contained by design (no cross-service imports
//   during the Phase 2/3 build-out). Now that the settlement layer is
//   stable, the duplication is safe to extract without behavior change.
//
// ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
//   Higher-level RPC calls (account_info, account_lines, submit, tx) remain
//   in each service because their return shapes differ (sequence vs balance
//   vs existence flag). Extracting them would either require a union type or
//   multiple near-identical helpers — not worth the added indirection.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   Services in src/services/ :  import { … } from "../xrpl/xrplRpc";
//   Files in    src/xrpl/    :  import { … } from "./xrplRpc";
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//   No business logic. No DB access. No seed handling. Zero side effects.
//   All functions are pure utilities or pure network I/O.
// ─────────────────────────────────────────────────────────────────────────────

// ── postJson ─────────────────────────────────────────────────────────────────

/**
 * Sends a JSON-RPC POST request over HTTP or HTTPS.
 *
 * Returns `{ status, text }` where `status` is the HTTP status code
 * and `text` is the raw response body string.
 *
 * Never parses JSON itself — callers are responsible for parsing and
 * interpreting the response body.
 *
 * Rejects on:
 *   - Network-level errors (ECONNREFUSED, ENOTFOUND, etc.)
 *   - Request timeout (destroys socket with an Error)
 *
 * Does NOT reject on non-200 HTTP status codes — callers must check
 * `result.status` themselves.
 *
 * @param url       Full URL of the JSON-RPC endpoint (http:// or https://)
 * @param body      Pre-serialized JSON string to send as the request body
 * @param timeoutMs Request timeout in milliseconds (default: 15 000)
 */
export function postJson(
  url:       string,
  body:      string,
  timeoutMs: number = 15_000
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed    = new URL(url);
    const isHttps   = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const port      = parsed.port || (isHttps ? 443 : 80);
    const bodyBuf   = Buffer.from(body, "utf8");

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port,
        path:     parsed.pathname + parsed.search,
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Content-Length": bodyBuf.length,
          "User-Agent":     "LumixPay/1.0",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end",  () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`postJson timed out after ${timeoutMs}ms: ${url}`))
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── sleep ────────────────────────────────────────────────────────────────────

/** Resolves after `ms` milliseconds. Used by retry loops and poll intervals. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── isXrplTransientError ─────────────────────────────────────────────────────

/**
 * Returns true when `err` represents a transient XRPL Testnet condition that
 * is safe to retry automatically:
 *
 *   - `noNetwork`    — XRPL node cannot reach peer network (JSON-RPC logical error)
 *   - `timeout`      — XRPL node reports internal timeout
 *   - `timed out`    — our own postJson socket timeout
 *   - `ECONNREFUSED` — connection refused (node down or port closed)
 *   - `ENOTFOUND`    — DNS resolution failed (network or hostname issue)
 *   - `ECONNRESET`   — connection forcibly closed mid-response
 *   - `ETIMEDOUT`    — OS-level TCP timeout
 *   - HTTP 5xx       — server-side error (rate limit, overload, etc.)
 *
 * Permanent errors (actNotFound, invalidParams, tecBAD_AUTH, etc.)
 * are NOT matched and will NOT be retried.
 */
export function isXrplTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("noNetwork")    ||
    msg.includes("timeout")      ||
    msg.includes("timed out")    ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND")    ||
    msg.includes("ECONNRESET")   ||
    msg.includes("ETIMEDOUT")    ||
    /HTTP [5]\d\d/.test(msg)
  );
}

// ── withRetry ────────────────────────────────────────────────────────────────

/**
 * Calls `fn` up to `maxAttempts` times, waiting `delayMs` between each
 * attempt, but ONLY retrying when `shouldRetry(err)` returns true.
 *
 * Non-retryable errors are rethrown immediately without waiting.
 * If all attempts are exhausted, the last error is rethrown.
 *
 * The optional `onRetry` callback is invoked after each failed attempt
 * before sleeping — useful for logging retry warnings.
 *
 * Example:
 *   const info = await withRetry(
 *     () => fetchAccountInfo(address, rpcUrl),
 *     isXrplTransientError,
 *     5,    // max 5 attempts
 *     2_000 // 2 s between retries
 *   );
 */
export async function withRetry<T>(
  fn:          () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  maxAttempts: number,
  delayMs:     number,
  onRetry?:    (attempt: number, err: unknown) => void
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err) || attempt >= maxAttempts) throw err;
      onRetry?.(attempt, err);
      await sleep(delayMs);
    }
  }
  throw lastErr; // unreachable — satisfies TypeScript
}

// ── assertTestnetRpc ─────────────────────────────────────────────────────────

/**
 * SAFETY GUARD — throws if `rpcUrl` does not look like an XRPL Testnet endpoint.
 *
 * LumixPay XRPL features are testnet-only. This guard is called before any
 * network operation to prevent accidental mainnet interaction in case of
 * misconfiguration (e.g. wrong XRPL_TESTNET_RPC_URL value).
 *
 * Valid testnet URLs must contain 'altnet' or 'rippletest' (case-insensitive).
 *   ✓ https://s.altnet.rippletest.net:51234
 *   ✓ wss://s.rippletest.net:51233
 *   ✗ https://s1.ripple.com           ← mainnet — will throw
 *
 * @param rpcUrl   The configured XRPL_TESTNET_RPC_URL value
 * @throws Error   If the URL does not pass the testnet check
 */
export function assertTestnetRpc(rpcUrl: string): void {
  const lower = rpcUrl.toLowerCase();
  if (!lower.includes("altnet") && !lower.includes("rippletest")) {
    throw new Error(
      `SAFETY GUARD: XRPL_TESTNET_RPC_URL "${rpcUrl}" does not appear to be an ` +
      `XRPL Testnet endpoint (must contain 'altnet' or 'rippletest'). ` +
      `Refusing to proceed — prevents accidental mainnet interaction.`
    );
  }
}
