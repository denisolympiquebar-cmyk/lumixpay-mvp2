// In dev: falls back to "/api" which is proxied by Vite → http://localhost:4000
// In production: set VITE_API_BASE=https://lumixpay-api.fly.dev  (no trailing slash)
const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

/**
 * Generate a fresh idempotency key for a single user-initiated write action.
 * Call once per button click / form submit — pass the result as the
 * "Idempotency-Key" header to any endpoint that enforces requireIdempotencyKey.
 *
 * Uses crypto.randomUUID() where available (Chrome 92+, Firefox 95+, Safari 15.4+,
 * all HTTPS contexts). Falls back to a Math.random-based UUID v4 for older browsers
 * so this function never throws.
 */
export function generateIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback: RFC-4122 UUID v4 via Math.random (sufficient entropy for idempotency keys)
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

/** Normalize any backend error payload to a human-readable string. */
function extractMessage(data: unknown): string {
  if (typeof data === "string" && data.length > 0) return data;
  if (data !== null && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d["error"] === "string") return d["error"];
    if (d["error"] !== null && typeof d["error"] === "object") {
      const inner = d["error"] as Record<string, unknown>;
      if (typeof inner["message"] === "string") return inner["message"];
    }
    if (typeof d["message"] === "string") return d["message"];
  }
  return "Request failed";
}

export async function apiFetch<T>(
  path: string,
  token: string | null,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    console.error(`[apiFetch] ${options.method ?? "GET"} ${url} → ${res.status}`, data);
    throw new Error(extractMessage(data));
  }

  return data as T;
}
