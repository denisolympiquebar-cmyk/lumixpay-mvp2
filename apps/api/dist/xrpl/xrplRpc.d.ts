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
export declare function postJson(url: string, body: string, timeoutMs?: number): Promise<{
    status: number;
    text: string;
}>;
/** Resolves after `ms` milliseconds. Used by retry loops and poll intervals. */
export declare function sleep(ms: number): Promise<void>;
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
export declare function isXrplTransientError(err: unknown): boolean;
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
export declare function withRetry<T>(fn: () => Promise<T>, shouldRetry: (err: unknown) => boolean, maxAttempts: number, delayMs: number, onRetry?: (attempt: number, err: unknown) => void): Promise<T>;
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
export declare function assertTestnetRpc(rpcUrl: string): void;
//# sourceMappingURL=xrplRpc.d.ts.map