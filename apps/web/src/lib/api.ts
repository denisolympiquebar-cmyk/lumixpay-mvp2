// In dev: falls back to "/api" which is proxied by Vite → http://localhost:4000
// In production: set VITE_API_BASE=https://lumixpay-api.fly.dev  (no trailing slash)
const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

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
    if (import.meta.env.DEV) {
      console.error(`[apiFetch] ${options.method ?? "GET"} ${url} → ${res.status}`, data);
    }
    const msg =
      typeof data === "string"
        ? data
        : data?.error?.message ?? data?.error ?? "Request failed";
    throw new Error(msg);
  }

  return data as T;
}
