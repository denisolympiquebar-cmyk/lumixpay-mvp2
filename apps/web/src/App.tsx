import React, { createContext, useContext, useMemo, useState, useEffect, useCallback } from "react";
import { Routes, Route, Navigate, Link, useNavigate, useLocation, useParams } from "react-router-dom";
import type { ApiUser, ApiAccountBalance } from "@lumixpay/shared";
import QRCode from "react-qr-code";
import { apiFetch, generateIdempotencyKey } from "./lib/api";
import { ToastProvider, useToast } from "./lib/toast";
import { canInstall, promptInstall, isIos, isInStandaloneMode } from "./lib/pwa-install";
import { subscribeToPush, unsubscribeFromPush, pushEnabled, getPushStatus, type PushUiStatus } from "./lib/push-notifications";
import { useStream } from "./lib/use-stream";
import "./dashboard.css";
import LandingPage      from "./pages/LandingPage";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { SlideToAction } from "./components/SlideToAction";
import PricingPage      from "./pages/PricingPage";
import DevelopersPage   from "./pages/DevelopersPage";
import DocsPage         from "./pages/DocsPage";
import DemoPage         from "./pages/DemoPage";
import ArchitecturePage from "./pages/ArchitecturePage";

// Google login (GIS)
declare global {
  interface Window {
    google?: any;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth context
// ─────────────────────────────────────────────────────────────────────────────

interface AuthCtx {
  token: string | null;
  user: ApiUser | null;
  ready: boolean;
  login: (token: string, user: ApiUser) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthCtx>({
  token: null,
  user: null,
  ready: true,
  login: () => {},
  logout: () => {},
});

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("lp_token"));
  const [user, setUser] = useState<ApiUser | null>(() => {
    const raw = localStorage.getItem("lp_user");
    return raw ? JSON.parse(raw) : null;
  });
  const [ready, setReady] = useState<boolean>(() => !localStorage.getItem("lp_token"));

  const login = (t: string, u: ApiUser) => {
    localStorage.setItem("lp_token", t);
    localStorage.setItem("lp_user", JSON.stringify(u));
    setToken(t);
    setUser(u);
    setReady(true);
  };
  const logout = () => {
    localStorage.removeItem("lp_token");
    localStorage.removeItem("lp_user");
    setToken(null);
    setUser(null);
    setReady(true);
  };

  // Bootstrapping: validate stored token and hydrate profile before route guards run.
  useEffect(() => {
    let cancelled = false;
    if (!token) { setReady(true); return; }

    setReady(false);
    apiFetch<{ profile: ApiUser }>("/me/profile", token)
      .then((d) => {
        if (cancelled) return;
        if (d?.profile) {
          setUser(d.profile);
          localStorage.setItem("lp_user", JSON.stringify(d.profile));
        }
        setReady(true);
      })
      .catch((e: any) => {
        if (cancelled) return;
        // Invalid / expired token → clear session (only case we force logout).
        console.warn("[auth] session restore failed:", e?.message ?? e);
        localStorage.removeItem("lp_token");
        localStorage.removeItem("lp_user");
        setToken(null);
        setUser(null);
        setReady(true);
      });

    return () => { cancelled = true; };
  }, [token]);

  return <AuthContext.Provider value={{ token, user, ready, login, logout }}>{children}</AuthContext.Provider>;
}

function useAuth() {
  return useContext(AuthContext);
}

// ─────────────────────────────────────────────────────────────────────────────
// Balances context (auto-refresh + shared state)
// ─────────────────────────────────────────────────────────────────────────────

type BalancesCtx = {
  accounts: ApiAccountBalance[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  setAccountsFromSSE: (accounts: ApiAccountBalance[]) => void;
};

const BalancesContext = createContext<BalancesCtx>({
  accounts: [],
  loading: false,
  error: "",
  refresh: async () => {},
  setAccountsFromSSE: () => {},
});

function BalancesProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [accounts, setAccounts] = useState<ApiAccountBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const d = await apiFetch<{ accounts: ApiAccountBalance[] }>("/me/accounts", token);
      setAccounts(d.accounts);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load balances");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // initial load + reload when token changes
  useEffect(() => {
    if (!token) {
      setAccounts([]);
      setError("");
      setLoading(false);
      return;
    }
    void refresh();
  }, [token, refresh]);

  const setAccountsFromSSE = useCallback((incoming: ApiAccountBalance[]) => {
    setAccounts(incoming);
  }, []);

  return (
    <BalancesContext.Provider value={{ accounts, loading, error, refresh, setAccountsFromSSE }}>
      {children}
    </BalancesContext.Provider>
  );
}

function useBalances() {
  return useContext(BalancesContext);
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications context — polls /notifications every 20 s when authenticated
// ─────────────────────────────────────────────────────────────────────────────

interface ApiNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
}

type NotificationsCtx = {
  notifications: ApiNotification[];
  unreadCount: number;
  refresh: () => Promise<void>;
  markAllRead: () => Promise<void>;
  setUnreadFromSSE: (count: number) => void;
  setSseActive: (active: boolean) => void;
};

const NotificationsContext = createContext<NotificationsCtx>({
  notifications: [],
  unreadCount: 0,
  refresh: async () => {},
  markAllRead: async () => {},
  setUnreadFromSSE: () => {},
  setSseActive: () => {},
});

function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [notifications, setNotifications] = useState<ApiNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [sseActive, setSseActiveState] = useState(false);
  // Guard: do not call setState after the provider unmounts (e.g. during logout)
  const mountedRef = React.useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const setUnreadFromSSE = useCallback((count: number) => {
    if (mountedRef.current) setUnreadCount(count);
  }, []);
  const setSseActive = useCallback((active: boolean) => {
    if (mountedRef.current) setSseActiveState(active);
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const d = await apiFetch<{ notifications: ApiNotification[] }>("/notifications?limit=30", token);
      if (!mountedRef.current) return;
      setNotifications(d.notifications);
      setUnreadCount(d.notifications.filter((n) => !n.is_read).length);
    } catch {
      // non-fatal — don't crash the app if notifications fail
    }
  }, [token]);

  const markAllRead = useCallback(async () => {
    if (!token) return;
    try {
      await apiFetch("/notifications/mark-all-read", token, { method: "POST" });
      if (!mountedRef.current) return;
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch {
      // non-fatal
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }
    void refresh();
    // When SSE is active, poll less often (60 s fallback). Otherwise 20 s.
    const pollInterval = sseActive ? 60_000 : 20_000;
    const interval = setInterval(() => void refresh(), pollInterval);
    return () => clearInterval(interval);
  }, [token, refresh, sseActive]);

  return (
    <NotificationsContext.Provider value={{ notifications, unreadCount, refresh, markAllRead, setUnreadFromSSE, setSseActive }}>
      {children}
    </NotificationsContext.Provider>
  );
}

function useNotifications() {
  return useContext(NotificationsContext);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function useQuery() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

function formatMoney(x: any) {
  const n = typeof x === "string" ? parseFloat(x) : Number(x);
  if (Number.isNaN(n)) return "0.00";
  return n.toFixed(2);
}

function getAccountBySymbol(accounts: ApiAccountBalance[], symbol: string) {
  return accounts.find((a) => a.asset?.display_symbol === symbol);
}

// 1% fee breakdown (mirrors backend FeeService)
function calcFee(gross: number): { fee: string; net: string } {
  if (!gross || gross <= 0) return { fee: "0.00", net: "0.00" };
  const fee = gross * 0.01;
  return { fee: fee.toFixed(2), net: (gross - fee).toFixed(2) };
}

function CopyButton({ text, label, style }: { text: string; label?: string; style?: React.CSSProperties }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      style={{ padding: "2px 8px", fontSize: "0.75rem", background: "var(--border)", marginLeft: 6, ...style }}
    >
      {copied ? "✓ Copied" : (label ?? "Copy")}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Financial UX primitives — used across all transaction pages
// ─────────────────────────────────────────────────────────────────────────────

function SkeletonLoader({ rows = 3, widths }: { rows?: number; widths?: number[] }) {
  return (
    <div className="skeleton-wrap">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="skeleton-row"
          style={{ width: `${widths?.[i] ?? 88 - i * 14}%` }}
        />
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    pending: "badge-pending", processing: "badge-processing",
    approved: "badge-approved", settled: "badge-settled",
    rejected: "badge-rejected", active: "badge-active", used: "badge-used",
  };
  return (
    <span className={`status-badge ${cls[status] ?? "badge-pending"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function FeedbackBanner({ type, message }: { type: "success" | "error" | "info" | "warning"; message: string }) {
  if (!message) return null;
  const icons = { success: "✓", error: "✕", info: "ℹ", warning: "⚠" };
  return (
    <div className={`feedback-banner feedback-${type}`}>
      <span className="fb-icon">{icons[type]}</span>
      <span>{message}</span>
    </div>
  );
}

function InlineHelp({ children }: { children: React.ReactNode }) {
  return <p className="inline-help">{children}</p>;
}

function ConfirmRow({ label, value, highlight = false }: {
  label: string; value: React.ReactNode; highlight?: boolean;
}) {
  return (
    <div className="confirm-row">
      <span className="confirm-label">{label}</span>
      <span className={`confirm-value${highlight ? " highlight" : ""}`}>{value}</span>
    </div>
  );
}

// Map raw backend error codes / messages to user-friendly strings
const ERROR_FRIENDLY: Record<string, string> = {
  TREASURY_EMPTY:          "This currency is temporarily unavailable. Please try again later.",
  TREASURY_INSUFFICIENT:   "Insufficient platform inventory. Try a smaller amount.",
  INSUFFICIENT_FUNDS:      "Your balance is too low for this transaction.",
  INSUFFICIENT_BALANCE:    "Your balance is too low for this transaction.",
  USER_FROZEN:             "Your account has been suspended. Please contact support.",
  IDEMPOTENCY_CONFLICT:    "This request was already submitted. Refresh to see the result.",
  RATE_LIMITED:            "Too many requests. Please wait a moment and try again.",
  INVALID_VOUCHER:         "This voucher code is invalid or has already been redeemed.",
  VOUCHER_USED:            "This voucher has already been redeemed.",
  RECIPIENT_NOT_FOUND:     "Recipient not found. Check the username or user ID and try again.",
  NOT_FOUND:               "The requested resource was not found.",
  UNAUTHORIZED:            "Your session has expired. Please log in again.",
  SETTLEMENT_IN_FLIGHT:    "Settlement is already in progress for this withdrawal.",
  ALREADY_SETTLED:         "This withdrawal has already been settled.",
  XRPL_ADDRESS_INVALID:         "That XRPL address does not look valid. Use a classic Testnet address (starts with r).",
  WALLET_CHALLENGE_INVALID:     "This verification message is invalid. Request a new one and try again.",
  WALLET_CHALLENGE_EXPIRED:     "The verification message expired. Request a new one.",
  XRPL_PUBLIC_KEY_INVALID:      "The public key could not be read. Paste the hex public key from your wallet (ED… or 02/03…).",
  XRPL_ADDRESS_KEY_MISMATCH:    "The public key does not match this XRPL address.",
  XRPL_SIGNATURE_INVALID:       "The signature could not be verified for this message and key.",
  XRPL_ADDRESS_ALREADY_LINKED:  "This XRPL address is already linked to another LumixPay account.",
  XRPL_SIGNING_PUBKEY_UNAVAILABLE:
    "Could not read a signing key for this address on XRPL Testnet. Use a funded Testnet account with an active master key, or try again later.",
  XRPL_RPC_ERROR:               "Could not reach XRPL Testnet. Check your connection and try again.",
};

function friendlyError(err: any): string {
  const raw: string = err?.message ?? String(err ?? "Something went wrong");
  for (const [code, msg] of Object.entries(ERROR_FRIENDLY)) {
    if (raw.toUpperCase().includes(code)) return msg;
  }
  if (!raw || /^[0-9a-f-]{20,}$/i.test(raw)) return "Something went wrong. Please try again.";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pages: Login / Register
// ─────────────────────────────────────────────────────────────────────────────

function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [gLoading, setGLoading] = useState(false);
  const googleBtnRef = React.useRef<HTMLDivElement | null>(null);
  const googleClientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID as string | undefined;

  const onGoogleCredential = useCallback(async (credential: string) => {
    setError("");
    setGLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: ApiUser }>("/auth/google", null, {
        method: "POST",
        body: JSON.stringify({ id_token: credential }),
      });
      login(data.token, data.user);
      navigate("/dashboard");
    } catch (e: any) {
      setError(e?.message ?? "Google login failed");
    } finally {
      setGLoading(false);
    }
  }, [login, navigate]);

  useEffect(() => {
    if (!googleClientId) return;
    const g = window.google;
    if (!g?.accounts?.id || !googleBtnRef.current) return;
    try {
      g.accounts.id.initialize({
        client_id: googleClientId,
        locale: "en",
        callback: (resp: any) => {
          const cred = resp?.credential;
          if (typeof cred === "string" && cred.length > 0) void onGoogleCredential(cred);
          else setError("Google sign-in did not return a credential");
        },
        ux_mode: "popup",
      });
      googleBtnRef.current.innerHTML = "";
      g.accounts.id.renderButton(googleBtnRef.current, {
        theme: "outline",
        size: "large",
        width: 320,
        text: "continue_with",
      });
    } catch (e) {
      console.error("GIS init error:", e);
    }
  }, [googleClientId, onGoogleCredential]);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: ApiUser }>("/auth/login", null, {
        method: "POST",
        body: JSON.stringify(form),
      });
      login(data.token, data.user);
      navigate("/dashboard");
    } catch (err: any) {
      setError(err.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100dvh", padding: "20px" }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ marginBottom: 10 }}>
          <Link to="/" className="muted" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            ← Back to Home
          </Link>
        </div>
        <div className="card" style={{ width: "100%" }}>
        <h1 style={{ marginBottom: 24, fontSize: "1.5rem" }}>LumixPay</h1>
        {googleClientId && (
          <div style={{ marginBottom: 14 }}>
            <div ref={googleBtnRef} />
            {gLoading && <p className="muted" style={{ marginTop: 8, fontSize: "0.82rem" }}>Signing in with Google…</p>}
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0" }}>
              <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
              <span className="muted" style={{ fontSize: "0.78rem" }}>or</span>
              <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
            </div>
          </div>
        )}
        <form onSubmit={handle} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <input
            type="email"
            placeholder="Email"
            required
            value={form.email}
            onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={form.password}
            onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign In"}
          </button>
          <p className="muted" style={{ textAlign: "center" }}>
            No account? <Link to="/register">Register</Link>
          </p>
        </form>
      </div>
      </div>
    </div>
  );
}

function RegisterPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "", full_name: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [gLoading, setGLoading] = useState(false);
  const googleBtnRef = React.useRef<HTMLDivElement | null>(null);
  const googleClientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID as string | undefined;

  const onGoogleCredential = useCallback(async (credential: string) => {
    setError("");
    setGLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: ApiUser }>("/auth/google", null, {
        method: "POST",
        body: JSON.stringify({ id_token: credential }),
      });
      login(data.token, data.user);
      navigate("/dashboard");
    } catch (e: any) {
      setError(e?.message ?? "Google signup failed");
    } finally {
      setGLoading(false);
    }
  }, [login, navigate]);

  useEffect(() => {
    if (!googleClientId) return;
    const g = window.google;
    if (!g?.accounts?.id || !googleBtnRef.current) return;
    try {
      g.accounts.id.initialize({
        client_id: googleClientId,
        locale: "en",
        callback: (resp: any) => {
          const cred = resp?.credential;
          if (typeof cred === "string" && cred.length > 0) void onGoogleCredential(cred);
          else setError("Google sign-up did not return a credential");
        },
        ux_mode: "popup",
      });
      googleBtnRef.current.innerHTML = "";
      g.accounts.id.renderButton(googleBtnRef.current, {
        theme: "outline",
        size: "large",
        width: 320,
        text: "continue_with",
      });
    } catch (e) {
      console.error("GIS init error:", e);
    }
  }, [googleClientId, onGoogleCredential]);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: ApiUser }>("/auth/register", null, {
        method: "POST",
        body: JSON.stringify(form),
      });
      login(data.token, data.user);
      navigate("/dashboard");
    } catch (err: any) {
      setError(err.message ?? "Register failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100dvh", padding: "20px" }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ marginBottom: 10 }}>
          <Link to="/" className="muted" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            ← Back to Home
          </Link>
        </div>
        <div className="card" style={{ width: "100%" }}>
        <h1 style={{ marginBottom: 24, fontSize: "1.5rem" }}>Create Account</h1>
        {googleClientId && (
          <div style={{ marginBottom: 14 }}>
            <div ref={googleBtnRef} />
            {gLoading && <p className="muted" style={{ marginTop: 8, fontSize: "0.82rem" }}>Continuing with Google…</p>}
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0" }}>
              <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
              <span className="muted" style={{ fontSize: "0.78rem" }}>or</span>
              <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
            </div>
          </div>
        )}
        <form onSubmit={handle} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <input
            placeholder="Full name"
            required
            value={form.full_name}
            onChange={(e) => setForm((p) => ({ ...p, full_name: e.target.value }))}
          />
          <input
            type="email"
            placeholder="Email"
            required
            value={form.email}
            onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
          />
          <input
            type="password"
            placeholder="Password (min 8 chars)"
            required
            minLength={8}
            value={form.password}
            onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={loading}>
            {loading ? "Creating…" : "Create Account"}
          </button>
          <p className="muted" style={{ textAlign: "center" }}>
            Have an account? <Link to="/login">Sign in</Link>
          </p>
        </form>
      </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

function DashboardPage() {
  const { user, token } = useAuth();
  const { accounts, loading, error, refresh } = useBalances();
  const [activity, setActivity] = useState<any[]>([]);

  useEffect(() => {
    if (!token || !accounts.length) return;
    const firstAccId = accounts[0]?.id;
    if (!firstAccId) return;
    apiFetch<{ entries: any[] }>(`/me/accounts/${firstAccId}/history?limit=10`, token)
      .then((d) => setActivity(d.entries ?? []))
      .catch(() => {});
  }, [token, accounts]);

  // SSE: prepend new activity entries as they arrive
  useStream(token, {
    "activity.new": (data) => {
      if (data?.entry) {
        setActivity((prev) => [data.entry, ...prev].slice(0, 10));
      }
    },
  });

  return (
    <div style={{ padding: "24px 20px", maxWidth: 920, margin: "0 auto" }}>
      <header style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ fontSize: "1.3rem", marginBottom: 4 }}>
            Welcome back, {user?.full_name?.split(" ")[0]}
          </h2>
          <p className="muted" style={{ fontSize: "0.8rem" }}>
            ID:{" "}
            <code style={{ background: "var(--bg)", padding: "1px 5px", borderRadius: 4 }}>{user?.id}</code>
            <CopyButton text={user?.id ?? ""} />
          </p>
        </div>
        <button onClick={refresh} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          ↻ Refresh
        </button>
      </header>

      {loading && (
        <div className="dash-grid" style={{ marginBottom: 24 }}>
          {[0, 1].map((i) => (
            <div key={i} className="widget"><SkeletonLoader rows={3} widths={[55, 80, 45]} /></div>
          ))}
        </div>
      )}
      {error && <FeedbackBanner type="error" message={error} />}

      {/* Balance cards */}
      {!loading && (
        <div className="dash-grid">
          {accounts.map((acc) => (
            <div key={acc.id} className="widget balance-card">
              <div className="balance-currency">
                {acc.asset.display_name}
                <span className="settle-tag">internal</span>
              </div>
              <div style={{ fontSize: "2rem", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text)", margin: "6px 0 4px" }}>
                {formatMoney(acc.balance.available)}
                <span style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--muted)", marginLeft: 8 }}>{acc.asset.display_symbol}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "0.73rem", color: "var(--muted)" }}>Available balance</span>
                {parseFloat(String(acc.balance.locked)) > 0 && (
                  <span className="locked-amount">🔒 {formatMoney(acc.balance.locked)} locked</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Quick actions */}
      <div className="widget" style={{ marginBottom: 20 }}>
        <div className="widget-title">Quick Actions</div>
        <div className="quick-actions">
          <Link to="/transfer" className="qa-btn"><span className="qa-icon">↗</span>Send</Link>
          <Link to="/topup"    className="qa-btn"><span className="qa-icon">💳</span>Top Up</Link>
          <Link to="/exchange" className="qa-btn"><span className="qa-icon">⇌</span>Exchange</Link>
          <Link to="/payment-links" className="qa-btn"><span className="qa-icon">🔗</span>Pay Link</Link>
          <Link to="/vouchers" className="qa-btn"><span className="qa-icon">🎟</span>Vouchers</Link>
        </div>
      </div>

      {/* Recent activity */}
      <div className="widget">
        <div className="widget-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Recent Activity</span>
          <Link to="/history" style={{ fontSize: "0.72rem", color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}>View all →</Link>
        </div>
        {loading && <SkeletonLoader rows={4} widths={[100, 100, 100, 100]} />}
        {!loading && activity.length === 0 && (
          <div style={{ padding: "16px 0", textAlign: "center" }}>
            <p className="muted" style={{ marginBottom: 8 }}>No transactions yet.</p>
            <Link to="/topup" style={{ fontSize: "0.82rem", color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}>
              Make your first top-up →
            </Link>
          </div>
        )}
        {!loading && activity.map((e) => {
          const acc = accounts.find(
            (a) => a.id === e.credit_account_id || a.id === e.debit_account_id
          );
          const incoming = acc && e.credit_account_id === acc.id;
          const icon = ENTRY_ICON[e.entry_type] ?? "·";
          const counterpartyLabel = e.entry_type === "transfer" && e.counterparty
            ? (incoming ? "from " : "to ") + (e.counterparty.username ? `@${e.counterparty.username}` : `${e.counterparty.id.slice(0, 8)}…`)
            : null;
          return (
            <div key={e.id} className="activity-row">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.85rem", flexShrink: 0 }}>{icon}</span>
                <div>
                  <div className="activity-type">{ENTRY_LABEL[e.entry_type] ?? e.entry_type}</div>
                  {counterpartyLabel && (
                    <div className="activity-time" style={{ fontWeight: 500 }}>{counterpartyLabel}</div>
                  )}
                  <div className="activity-time">{new Date(e.created_at).toLocaleString()}</div>
                </div>
              </div>
              <span className={incoming ? "activity-amount-pos" : "activity-amount-neg"}>
                {incoming ? "+" : "−"}{formatMoney(e.amount)} {acc?.asset.display_symbol ?? ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TopUp page (simple form)
// ─────────────────────────────────────────────────────────────────────────────

function TopUpPage() {
  const { token } = useAuth();
  const { accounts, refresh } = useBalances();
  const { refresh: refreshNotifs } = useNotifications();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const [assetId, setAssetId] = useState<string>(() => accounts.find((a) => a.asset.display_symbol === "RLUSD")?.asset_id ?? "");
  const [amount, setAmount] = useState<number>(20);
  const [last4, setLast4] = useState("4242");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"form" | "confirm" | "success">("form");
  const [successData, setSuccessData] = useState<{ net: string; symbol: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const rlusd = getAccountBySymbol(accounts, "RLUSD");
    if (!assetId && rlusd?.asset_id) setAssetId(rlusd.asset_id);
  }, [accounts, assetId]);

  const selectedAcc = accounts.find((a) => a.asset_id === assetId);
  const feeCalc = calcFee(amount);

  const handleConfirm = async () => {
    setErrorMsg("");
    setLoading(true);

    // Generate the idempotency key BEFORE entering the try block so that:
    //  a) it is never silently swallowed if crypto.randomUUID() throws
    //  b) the diagnostic log always fires before the network request
    const idempotencyKey = generateIdempotencyKey();
    console.log("[TopUp] Sending POST /topup", {
      endpoint: "/topup",
      method: "POST",
      "Idempotency-Key": idempotencyKey
        ? `present (${idempotencyKey.length} chars, prefix: ${idempotencyKey.slice(0, 8)})`
        : "MISSING — request will be rejected by backend",
    });

    try {
      await apiFetch("/topup", token, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ asset_id: assetId, gross_amount: amount, simulated_card_last4: last4 }),
      });
      await refresh();
      void refreshNotifs();
      setSuccessData({ net: feeCalc.net, symbol: selectedAcc?.asset.display_symbol ?? "" });
      setStep("success");
      addToast("Top-up completed!", "success");
    } catch (err: any) {
      const msg = friendlyError(err);
      setErrorMsg(msg);
      addToast(msg, "error");
      setStep("form");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 540, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Top Up</h2>
          <p className="muted" style={{ fontSize: "0.78rem" }}>Add funds to your LumixPay balance</p>
        </div>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          Back
        </button>
      </header>

      {errorMsg && <FeedbackBanner type="error" message={errorMsg} />}

      {step === "form" && (
        <div className="card">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="form-field">
              <label className="form-label">Currency</label>
              <select value={assetId} onChange={(e) => setAssetId(e.target.value)} required>
                {accounts.map((a) => (
                  <option key={a.id} value={a.asset_id}>
                    {a.asset.display_symbol} &mdash; {a.asset.display_name}
                  </option>
                ))}
              </select>
              {selectedAcc && (
                <span className="form-hint">Current balance: {formatMoney(selectedAcc.balance.available)} {selectedAcc.asset.display_symbol}</span>
              )}
            </div>

            <div className="form-field">
              <label className="form-label">Amount</label>
              <select value={String(amount)} onChange={(e) => setAmount(parseInt(e.target.value, 10))}>
                {[10, 20, 50, 100].map((x) => (
                  <option key={x} value={x}>{x} {selectedAcc?.asset.display_symbol ?? ""}</option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label className="form-label">Simulated card (last 4 digits)</label>
              <input value={last4} onChange={(e) => setLast4(e.target.value)} maxLength={4} placeholder="e.g. 4242" />
              <span className="form-hint">This is a simulated card top-up for demo purposes.</span>
            </div>

            {amount > 0 && (
              <div className="confirm-panel" style={{ margin: 0 }}>
                <ConfirmRow label="Gross amount" value={`${amount} ${selectedAcc?.asset.display_symbol ?? ""}`} />
                <ConfirmRow label="Platform fee (1%)" value={`${feeCalc.fee} ${selectedAcc?.asset.display_symbol ?? ""}`} />
                <ConfirmRow label="You will receive" value={`${feeCalc.net} ${selectedAcc?.asset.display_symbol ?? ""}`} highlight />
              </div>
            )}

            <button onClick={() => setStep("confirm")} disabled={!assetId || !amount}>
              Review Top-up
            </button>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <div className="card">
          <h3 style={{ marginBottom: 4, fontSize: "1rem" }}>Confirm Top-up</h3>
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 14 }}>Please review the details before confirming.</p>
          <div className="confirm-panel">
            <ConfirmRow label="Currency" value={selectedAcc?.asset.display_name ?? assetId} />
            <ConfirmRow label="Gross amount" value={`${amount} ${selectedAcc?.asset.display_symbol ?? ""}`} />
            <ConfirmRow label="Platform fee (1%)" value={`${feeCalc.fee} ${selectedAcc?.asset.display_symbol ?? ""}`} />
            <ConfirmRow label="Amount credited" value={`${feeCalc.net} ${selectedAcc?.asset.display_symbol ?? ""}`} highlight />
            <ConfirmRow label="Settlement" value={<span className="settle-tag">Internal balance</span>} />
          </div>
          <InlineHelp>Funds are added to your internal LumixPay balance. No blockchain transaction is required.</InlineHelp>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={() => setStep("form")} style={{ background: "var(--surface)", border: "1px solid var(--border)", flex: 1 }}>
              Edit
            </button>
            <button onClick={handleConfirm} disabled={loading} style={{ flex: 2 }}>
              {loading ? "Processing..." : `Confirm - Add ${feeCalc.net} ${selectedAcc?.asset.display_symbol ?? ""}`}
            </button>
          </div>
        </div>
      )}

      {step === "success" && successData && (
        <div className="card">
          <div className="success-screen">
            <div className="success-icon">&#10003;</div>
            <div className="success-title">Top-up complete</div>
            <div className="success-sub">
              {successData.net} {successData.symbol} has been added to your LumixPay balance.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => { setStep("form"); setSuccessData(null); setErrorMsg(""); }}
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
              >
                Top up again
              </button>
              <button onClick={() => navigate("/dashboard")}>Back to dashboard</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfer page (form)
// ─────────────────────────────────────────────────────────────────────────────

function TransferPage() {
  const { token } = useAuth();
  const { accounts, refresh } = useBalances();
  const { refresh: refreshNotifs } = useNotifications();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const [assetId, setAssetId] = useState<string>("");
  const [recipient, setRecipient] = useState<string>("");
  const [grossAmount, setGrossAmount] = useState<number>(10);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"form" | "confirm" | "success">("form");
  const [successData, setSuccessData] = useState<{ net: string; symbol: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const rlusd = getAccountBySymbol(accounts, "RLUSD");
    if (!assetId && rlusd?.asset_id) setAssetId(rlusd.asset_id);
  }, [accounts, assetId]);

  const selectedAcc = accounts.find((a) => a.asset_id === assetId);
  const xferCalc = calcFee(grossAmount);
  const exceedsBalance = selectedAcc && grossAmount > parseFloat(String(selectedAcc.balance.available));

  const handleConfirm = async () => {
    setErrorMsg("");
    setLoading(true);
    const idempotencyKey = generateIdempotencyKey();
    console.log("[Transfer] Sending POST /transfers", {
      endpoint: "/transfers",
      method: "POST",
      "Idempotency-Key": `present (${idempotencyKey.slice(0, 8)}…)`,
    });
    try {
      const res = await apiFetch<any>("/transfers", token, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ recipient: recipient.trim(), asset_id: assetId, gross_amount: grossAmount }),
      });
      await refresh();
      void refreshNotifs();
      setSuccessData({ net: res?.transfer?.net_amount ?? xferCalc.net, symbol: selectedAcc?.asset.display_symbol ?? "" });
      setStep("success");
      addToast("Transfer sent!", "success");
    } catch (err: any) {
      const msg = friendlyError(err);
      setErrorMsg(msg);
      addToast(msg, "error");
      setStep("form");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 540, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Transfer</h2>
          <p className="muted" style={{ fontSize: "0.78rem" }}>Send funds to another LumixPay user instantly</p>
        </div>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          Back
        </button>
      </header>

      {errorMsg && <FeedbackBanner type="error" message={errorMsg} />}

      {step === "form" && (
        <div className="card">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="form-field">
              <label className="form-label">Currency</label>
              <select value={assetId} onChange={(e) => setAssetId(e.target.value)} required>
                {accounts.map((a) => (
                  <option key={a.id} value={a.asset_id}>{a.asset.display_symbol} &mdash; {a.asset.display_name}</option>
                ))}
              </select>
              {selectedAcc && (
                <span className="form-hint">Available: {formatMoney(selectedAcc.balance.available)} {selectedAcc.asset.display_symbol}</span>
              )}
            </div>

            <div className="form-field">
              <label className="form-label">Recipient (User ID or username)</label>
              <input
                placeholder="e.g. alice_pay or paste a user ID (UUID)"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
              <span className="form-hint">Enter a username (e.g. alice_pay) or paste a user ID. Ask the recipient to share their username from their Profile page.</span>
            </div>

            <div className="form-field">
              <label className="form-label">Amount</label>
              <input
                type="number" min={0.01} step="0.01" value={grossAmount}
                onChange={(e) => setGrossAmount(parseFloat(e.target.value))} required
              />
            </div>

            {grossAmount > 0 && (
              <div className="confirm-panel" style={{ margin: 0 }}>
                <ConfirmRow label="Gross amount" value={`${grossAmount} ${selectedAcc?.asset.display_symbol ?? ""}`} />
                <ConfirmRow label="Platform fee (1%)" value={`${xferCalc.fee} ${selectedAcc?.asset.display_symbol ?? ""}`} />
                <ConfirmRow label="Recipient receives" value={`${xferCalc.net} ${selectedAcc?.asset.display_symbol ?? ""}`} highlight />
              </div>
            )}

            {exceedsBalance && (
              <FeedbackBanner type="error" message="Amount exceeds your available balance." />
            )}

            <button
              onClick={() => setStep("confirm")}
              disabled={!assetId || !recipient.trim() || grossAmount <= 0 || !!exceedsBalance}
            >
              Review Transfer
            </button>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <div className="card">
          <h3 style={{ marginBottom: 4, fontSize: "1rem" }}>Confirm Transfer</h3>
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 14 }}>Transfers are instant and cannot be reversed.</p>
          <div className="confirm-panel">
            <ConfirmRow label="Currency" value={selectedAcc?.asset.display_name ?? assetId} />
            <ConfirmRow label="Recipient" value={<code style={{ fontSize: "0.77rem", wordBreak: "break-all" }}>{recipient.trim()}</code>} />
            <ConfirmRow label="Gross amount" value={`${grossAmount} ${selectedAcc?.asset.display_symbol ?? ""}`} />
            <ConfirmRow label="Platform fee (1%)" value={`${xferCalc.fee} ${selectedAcc?.asset.display_symbol ?? ""}`} />
            <ConfirmRow label="Recipient receives" value={`${xferCalc.net} ${selectedAcc?.asset.display_symbol ?? ""}`} highlight />
            <ConfirmRow label="Settlement" value={<span className="settle-tag">Internal</span>} />
          </div>
          <InlineHelp>This is an internal transfer between LumixPay accounts. It settles instantly with no blockchain transaction.</InlineHelp>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={() => setStep("form")} style={{ background: "var(--surface)", border: "1px solid var(--border)", flex: 1 }}>
              Edit
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            <SlideToAction
              label="slide to confirm transfer"
              onComplete={handleConfirm}
              disabled={loading}
            />
          </div>
        </div>
      )}

      {step === "success" && successData && (
        <div className="card">
          <div className="success-screen">
            <div className="success-icon">&#10003;</div>
            <div className="success-title">Transfer sent</div>
            <div className="success-sub">
              {successData.net} {successData.symbol} has been sent successfully.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => { setStep("form"); setSuccessData(null); setErrorMsg(""); setRecipient(""); setGrossAmount(10); }}
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
              >
                Send again
              </button>
              <button onClick={() => navigate("/dashboard")}>Back to dashboard</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Withdraw page (form)
// ─────────────────────────────────────────────────────────────────────────────

function WithdrawPage() {
  const { token } = useAuth();
  const { accounts, refresh } = useBalances();
  const { refresh: refreshNotifs } = useNotifications();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const [assetId, setAssetId] = useState<string>("");
  const [grossAmount, setGrossAmount] = useState<number>(5);
  const [xrplAddress, setXrplAddress] = useState<string>("");
  const [xrplTag, setXrplTag] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"form" | "confirm" | "submitted">("form");
  const [withdrawalId, setWithdrawalId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const rlusd = getAccountBySymbol(accounts, "RLUSD");
    if (!assetId && rlusd?.asset_id) setAssetId(rlusd.asset_id);
  }, [accounts, assetId]);

  const selectedAcc = accounts.find((a) => a.asset_id === assetId);
  const wCalc = calcFee(grossAmount);
  const exceedsBalance = selectedAcc && grossAmount > parseFloat(String(selectedAcc.balance.available));

  const handleConfirm = async () => {
    setErrorMsg("");
    setLoading(true);
    try {
      const payload: any = {
        asset_id: assetId,
        gross_amount: grossAmount,
        xrpl_destination_address: xrplAddress.trim(),
      };
      const tagTrim = xrplTag.trim();
      if (tagTrim) payload.xrpl_destination_tag = Number(tagTrim);
      const res = await apiFetch<any>("/withdrawals", token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() },
        body: JSON.stringify(payload),
      });
      await refresh();
      void refreshNotifs();
      setWithdrawalId(res?.withdrawal?.id ?? null);
      setStep("submitted");
      addToast("Withdrawal request submitted", "info");
    } catch (err: any) {
      const msg = friendlyError(err);
      setErrorMsg(msg);
      addToast(msg, "error");
      setStep("form");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 540, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Withdraw</h2>
          <p className="muted" style={{ fontSize: "0.78rem" }}>Send funds to an XRPL destination address</p>
        </div>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          Back
        </button>
      </header>

      {errorMsg && <FeedbackBanner type="error" message={errorMsg} />}

      {step === "form" && (
        <div className="card">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="form-field">
              <label className="form-label">Currency</label>
              <select value={assetId} onChange={(e) => setAssetId(e.target.value)} required>
                {accounts.map((a) => (
                  <option key={a.id} value={a.asset_id}>{a.asset.display_symbol} &mdash; {a.asset.display_name}</option>
                ))}
              </select>
              {selectedAcc && (
                <span className="form-hint">Available: {formatMoney(selectedAcc.balance.available)} {selectedAcc.asset.display_symbol}</span>
              )}
            </div>

            <div className="form-field">
              <label className="form-label">Amount</label>
              <input
                type="number" min={0.01} step="0.01" value={grossAmount}
                onChange={(e) => setGrossAmount(parseFloat(e.target.value))} required
              />
            </div>

            {grossAmount > 0 && (
              <div className="confirm-panel" style={{ margin: 0 }}>
                <ConfirmRow label="Gross amount" value={`${grossAmount} ${selectedAcc?.asset.display_symbol ?? ""}`} />
                <ConfirmRow label="Platform fee (1%)" value={`${wCalc.fee} ${selectedAcc?.asset.display_symbol ?? ""}`} />
                <ConfirmRow label="Net locked in escrow" value={`${wCalc.net} ${selectedAcc?.asset.display_symbol ?? ""}`} highlight />
              </div>
            )}

            {exceedsBalance && (
              <FeedbackBanner type="error" message="Amount exceeds your available balance." />
            )}

            <div className="form-field">
              <label className="form-label">XRPL destination address</label>
              <input value={xrplAddress} onChange={(e) => setXrplAddress(e.target.value)} required placeholder="r..." />
            </div>

            <div className="form-field">
              <label className="form-label">Destination tag <span style={{ fontWeight: 400, color: "var(--muted)" }}>(optional)</span></label>
              <input placeholder="e.g. 12345" value={xrplTag} onChange={(e) => setXrplTag(e.target.value)} inputMode="numeric" />
              <span className="form-hint">Required by some exchanges (e.g. Bitso, Kraken). Check with your destination before sending.</span>
            </div>

            <button
              onClick={() => setStep("confirm")}
              disabled={!assetId || !xrplAddress.trim() || grossAmount <= 0 || !!exceedsBalance}
            >
              Review Withdrawal
            </button>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <div className="card">
          <h3 style={{ marginBottom: 4, fontSize: "1rem" }}>Confirm Withdrawal</h3>
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 14 }}>
            Verify the destination address carefully. Withdrawals cannot be reversed once approved.
          </p>
          <div className="confirm-panel">
            <ConfirmRow label="Currency" value={selectedAcc?.asset.display_name ?? assetId} />
            <ConfirmRow label="Gross amount" value={`${grossAmount} ${selectedAcc?.asset.display_symbol ?? ""}`} />
            <ConfirmRow label="Platform fee (1%)" value={`${wCalc.fee} ${selectedAcc?.asset.display_symbol ?? ""}`} />
            <ConfirmRow label="Net to escrow" value={`${wCalc.net} ${selectedAcc?.asset.display_symbol ?? ""}`} highlight />
            <ConfirmRow label="Destination" value={<code style={{ fontSize: "0.75rem", wordBreak: "break-all" }}>{xrplAddress.trim()}</code>} />
            {xrplTag.trim() && <ConfirmRow label="Destination tag" value={xrplTag.trim()} />}
            <ConfirmRow label="Settlement" value={<span className="settle-tag on-chain">XRPL (Phase 2)</span>} />
          </div>
          <InlineHelp>Net amount is locked in escrow. A LumixPay operator will review and approve before on-chain settlement.</InlineHelp>
          <p className="muted" style={{ fontSize: "0.75rem", margin: "10px 0 0", padding: "7px 10px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
            ⚠ Settlement is currently simulated in this phase. Status and any transaction hash shown are mock outputs. Live XRPL settlement will be enabled in a future phase.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={() => setStep("form")} style={{ background: "var(--surface)", border: "1px solid var(--border)", flex: 1 }}>
              Edit
            </button>
            <button onClick={handleConfirm} disabled={loading} style={{ flex: 2 }}>
              {loading ? "Submitting..." : "Confirm Withdrawal Request"}
            </button>
          </div>
        </div>
      )}

      {step === "submitted" && (
        <div className="card">
          <div className="success-screen" style={{ paddingBottom: 8 }}>
            <div className="success-icon" style={{ background: "color-mix(in srgb,#3b82f6 14%,var(--surface))", fontSize: "1.3rem" }}>&#128336;</div>
            <div className="success-title">Withdrawal request submitted</div>
            <div className="success-sub">Your funds are locked in escrow and awaiting admin review.</div>
          </div>
          <div className="tx-timeline">
            <div className="tx-step done">
              <div>
                <div className="tx-step-label">Request received</div>
                <div className="tx-step-sub">Net amount locked in escrow pending review</div>
              </div>
            </div>
            <div className="tx-step active">
              <div>
                <div className="tx-step-label">Admin review</div>
                <div className="tx-step-sub">A LumixPay operator will approve or reject your request</div>
              </div>
            </div>
            <div className="tx-step">
              <div>
                <div className="tx-step-label">On-chain settlement</div>
                <div className="tx-step-sub">Approved withdrawals settle to your XRPL address (Phase 2)</div>
              </div>
            </div>
          </div>
          {withdrawalId && (
            <p className="muted" style={{ fontSize: "0.72rem", marginTop: 12, textAlign: "center" }}>
              Reference: <code>{withdrawalId}</code>
            </p>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "center" }}>
            <button onClick={() => navigate("/dashboard")}>Back to dashboard</button>
            <button
              onClick={() => { setStep("form"); setWithdrawalId(null); setErrorMsg(""); }}
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            >
              New withdrawal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction History page  /history
// ─────────────────────────────────────────────────────────────────────────────

const ENTRY_LABEL: Record<string, string> = {
  topup:              "Top Up",
  transfer:           "Transfer",
  fee:                "Platform fee",
  withdrawal_lock:    "Withdrawal (pending)",
  withdrawal_unlock:  "Withdrawal cancelled",
  withdrawal_settle:  "Withdrawal settled",
  fx_conversion:      "Currency exchange",
  voucher_redeem:     "Voucher redeemed",
  voucher_purchase:   "Voucher purchased",
  payment_link_claim: "Payment received",
  recurring:          "Recurring payment",
};
const ENTRY_ICON: Record<string, string> = {
  topup:              "⬇",
  transfer:           "↗",
  fee:                "·",
  withdrawal_lock:    "🔒",
  withdrawal_unlock:  "🔓",
  withdrawal_settle:  "✓",
  fx_conversion:      "⇌",
  voucher_redeem:     "🎟",
  voucher_purchase:   "🎟",
  payment_link_claim: "💳",
  recurring:          "↻",
};

function HistoryPage() {
  const { token } = useAuth();
  const { accounts } = useBalances();
  const navigate = useNavigate();

  const [accountId, setAccountId] = useState<string>("");
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Default to first account once accounts are available
  useEffect(() => {
    if (!accountId && accounts.length > 0) {
      setAccountId(accounts[0]!.id);
    }
  }, [accounts, accountId]);

  // Fetch history whenever the selected account changes
  useEffect(() => {
    if (!accountId || !token) return;
    setLoading(true);
    setError("");
    apiFetch<{ entries: any[] }>(`/me/accounts/${accountId}/history?limit=50`, token)
      .then((d) => setEntries(d.entries ?? []))
      .catch((e: any) => setError(e.message ?? "Failed to load history"))
      .finally(() => setLoading(false));
  }, [accountId, token]);

  const selectedAcc = accounts.find((a) => a.id === accountId);

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2>Transaction History</h2>
        <button
          onClick={() => navigate("/dashboard")}
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          Back
        </button>
      </header>

      <div style={{ marginBottom: 16 }}>
        <label className="muted" style={{ display: "block", marginBottom: 6 }}>
          Account
        </label>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.asset.display_symbol} — {a.asset.display_name}
            </option>
          ))}
        </select>
      </div>

      {loading && <SkeletonLoader rows={5} widths={[100,100,100,100,100]} />}
      {error && <FeedbackBanner type="error" message={error} />}
      {!loading && !error && entries.length === 0 && (
        <p className="muted" style={{ padding: "12px 0" }}>No transactions recorded for this account yet.</p>
      )}

      <div className="tx-list-scroll" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {entries.map((e) => {
          const incoming = e.credit_account_id === accountId;
          const sign = incoming ? "+" : "−";
          const color = incoming ? "var(--success)" : "var(--muted)";
          const icon = ENTRY_ICON[e.entry_type] ?? "·";
          const counterpartyLabel = e.entry_type === "transfer" && e.counterparty
            ? (incoming ? "From " : "To ") + (e.counterparty.username ? `@${e.counterparty.username}` : `${e.counterparty.id.slice(0, 8)}…`)
            : null;
          return (
            <div
              key={e.id}
              className="card"
              style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.9rem", flexShrink: 0 }}>{icon}</span>
                <div>
                  <p style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                    {ENTRY_LABEL[e.entry_type] ?? e.entry_type}
                  </p>
                  {counterpartyLabel && (
                    <p className="muted" style={{ fontSize: "0.73rem", fontWeight: 500 }}>{counterpartyLabel}</p>
                  )}
                  <p className="muted" style={{ fontSize: "0.73rem" }}>{new Date(e.created_at).toLocaleString()}</p>
                </div>
              </div>
              <p style={{ fontWeight: 700, fontSize: "1rem", color, flexShrink: 0 }}>
                {sign}{formatMoney(e.amount)} <span style={{ fontSize: "0.78rem", fontWeight: 600 }}>{selectedAcc?.asset.display_symbol ?? ""}</span>
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Withdrawals page  /admin/withdrawals
// ─────────────────────────────────────────────────────────────────────────────

interface AdminWithdrawal {
  id: string;
  user_email: string;
  currency: string;
  gross_amount: string;
  fee_amount: string;
  net_amount: string;
  xrpl_destination_address: string;
  xrpl_destination_tag: number | null;
  status: string;
  admin_note: string | null;
  created_at: string;
}

function AdminWithdrawalsPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();

  const [withdrawals, setWithdrawals] = useState<AdminWithdrawal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("pending");
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [actionMsg, setActionMsg] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const d = await apiFetch<{ withdrawals: AdminWithdrawal[] }>(
        `/withdrawals/admin?status=${statusFilter}`,
        token
      );
      setWithdrawals(d.withdrawals ?? []);
    } catch (e: any) {
      setError(e.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const review = async (id: string, decision: "approve" | "reject", note?: string) => {
    setActionMsg("");
    try {
      await apiFetch(`/withdrawals/admin/${id}/review`, token, {
        method: "POST",
        body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
      });
      setActionMsg(decision === "approve" ? "Approved ✅" : "Rejected ✅");
      setRejectingId(null);
      setRejectNote("");
      void load();
    } catch (e: any) {
      setActionMsg(e.message ?? "Action failed");
    }
  };

  // Non-admins see an access-denied message instead of a crash
  if (user?.role !== "admin") {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <p className="error" style={{ marginBottom: 16 }}>Access denied — admin only.</p>
        <Link to="/dashboard">← Back to Dashboard</Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2>Admin — Withdrawals</h2>
        <button
          onClick={() => navigate("/dashboard")}
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          Back
        </button>
      </header>

      {/* Settlement phase notice */}
      <p className="muted" style={{ fontSize: "0.78rem", marginBottom: 14, padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
        ⚠ Settlement is currently simulated (Phase 1). Status transitions and any tx hash shown are mock outputs. Live XRPL settlement will be enabled in Phase 2.
      </p>

      {/* Status filter tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <span className="muted">Filter:</span>
        {["pending", "approved", "rejected", "settled"].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            style={{
              padding: "5px 14px",
              fontSize: "0.82rem",
              background: statusFilter === s ? "var(--accent)" : "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            {s}
          </button>
        ))}
        <button
          type="button"
          onClick={load}
          style={{ padding: "5px 12px", fontSize: "0.82rem", background: "var(--border)" }}
        >
          ↻ Refresh
        </button>
      </div>

      {actionMsg && (
        <p className={actionMsg.includes("✅") ? "muted" : "error"} style={{ marginBottom: 12 }}>
          {actionMsg}
        </p>
      )}
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && withdrawals.length === 0 && (
        <p className="muted">No withdrawals with status "{statusFilter}".</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {withdrawals.map((w) => (
          <div key={w.id} className="card">
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 600 }}>{w.user_email}</p>
                <p className="muted">
                  {w.currency} · Gross: {formatMoney(w.gross_amount)} · Fee:{" "}
                  {formatMoney(w.fee_amount)} · Net: {formatMoney(w.net_amount)}
                </p>
                <p className="muted" style={{ wordBreak: "break-all", marginTop: 2 }}>
                  → {w.xrpl_destination_address}
                  {w.xrpl_destination_tag != null ? ` (tag: ${w.xrpl_destination_tag})` : ""}
                </p>
                <p className="muted" style={{ marginTop: 2 }}>
                  {new Date(w.created_at).toLocaleString()}
                </p>
                {w.admin_note && (
                  <p className="muted" style={{ marginTop: 2, fontStyle: "italic" }}>
                    Note: {w.admin_note}
                  </p>
                )}
              </div>
              <div>
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 20,
                    fontSize: "0.78rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    background:
                      w.status === "pending"
                        ? "var(--accent)"
                        : w.status === "approved"
                        ? "var(--success)"
                        : w.status === "rejected"
                        ? "var(--danger)"
                        : "var(--border)",
                    color: "#fff",
                  }}
                >
                  {w.status}
                </span>
              </div>
            </div>

            {/* Approve / Reject controls — only for pending */}
            {w.status === "pending" && (
              <div style={{ marginTop: 12 }}>
                {rejectingId === w.id ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <input
                      placeholder="Rejection note (optional)"
                      value={rejectNote}
                      onChange={(e) => setRejectNote(e.target.value)}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => review(w.id, "reject", rejectNote || undefined)}
                        style={{ background: "var(--danger)" }}
                      >
                        Confirm Reject
                      </button>
                      <button
                        type="button"
                        onClick={() => { setRejectingId(null); setRejectNote(""); }}
                        style={{ background: "var(--border)" }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => review(w.id, "approve")}
                      style={{ background: "var(--success)" }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejectingId(w.id)}
                      style={{ background: "var(--danger)" }}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications inbox page
// ─────────────────────────────────────────────────────────────────────────────

function NotificationsPage() {
  const { token } = useAuth();
  const { notifications, unreadCount, refresh, markAllRead } = useNotifications();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [pushStatus, setPushStatus] = useState<PushUiStatus>("DISABLED");
  const [pushWorking, setPushWorking] = useState(false);

  // Auto-mark all as read when inbox opens
  useEffect(() => {
    if (unreadCount > 0) void markAllRead();
    void getPushStatus().then(setPushStatus).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typeLabel: Record<string, string> = {
    "topup.completed":       "💳 Top-up",
    "transfer.sent":         "↗ Transfer sent",
    "transfer.received":     "↙ Transfer received",
    "withdrawal.requested":  "📤 Withdrawal submitted",
    "withdrawal.approved":   "✅ Withdrawal approved",
    "withdrawal.rejected":   "❌ Withdrawal rejected",
    "withdrawal.settled":    "✔ Withdrawal settled",
    "voucher.redeemed":      "🎟 Voucher redeemed",
    "payment_link.paid":     "🔗 Payment link paid",
    "recurring.executed":    "🔁 Recurring payment",
  };

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2>Notifications</h2>
          {unreadCount > 0 && (
            <p className="muted">{unreadCount} unread</p>
          )}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: "0.85rem" }}
            >
              Mark all read
            </button>
          )}
          <button
            onClick={() => void refresh()}
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            Refresh
          </button>
          <button
            onClick={() => navigate("/dashboard")}
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            Back
          </button>
        </div>
      </header>

      {/* Push status (user-triggered; no auto-permission request) */}
      <div className="card" style={{ marginBottom: 14, padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Push notifications</div>
            <div className="muted" style={{ fontSize: "0.82rem", lineHeight: 1.5 }}>
              Status:{" "}
              <strong>
                {pushStatus === "ENABLED"
                  ? "Enabled"
                  : pushStatus === "DISABLED"
                  ? "Disabled"
                  : pushStatus === "BLOCKED"
                  ? "Browser blocked"
                  : pushStatus === "PERMISSION_REQUIRED"
                  ? "Permission required"
                  : "Unsupported"}
              </strong>
            </div>
          </div>
          {"Notification" in window && "serviceWorker" in navigator ? (
            <button
              disabled={pushWorking || !token || pushStatus === "UNSUPPORTED"}
              onClick={async () => {
                if (!token) return;
                setPushWorking(true);
                try {
                  if (pushStatus === "ENABLED") {
                    await unsubscribeFromPush(token);
                    setPushStatus("DISABLED");
                    addToast("Push notifications disabled", "info");
                  } else {
                    const ok = await subscribeToPush(token);
                    if (ok) {
                      setPushStatus("ENABLED");
                      addToast("Push notifications enabled", "success");
                    } else {
                      setPushStatus(Notification.permission === "denied" ? "BLOCKED" : "PERMISSION_REQUIRED");
                      addToast("Push permission was not granted", "info");
                    }
                  }
                } catch (e: any) {
                  console.error("[Push] UI error (notifications page):", e);
                  addToast(e?.message ?? "Push setup failed", "error");
                } finally {
                  setPushWorking(false);
                }
              }}
              style={{ whiteSpace: "nowrap" }}
            >
              {pushWorking ? "Working…" : pushStatus === "ENABLED" ? "Disable Push" : "Enable Push"}
            </button>
          ) : null}
        </div>
        <p className="muted" style={{ fontSize: "0.75rem", marginTop: 10, marginBottom: 0 }}>
          Push is always user-enabled. If setup fails, check that notifications are allowed in your browser site settings.
          Some environments block push by default — including Brave Shields, iOS Safari (requires the app to be installed as a PWA first), and private/incognito windows.
          For the most reliable experience use Chrome or Firefox on desktop.
        </p>
      </div>

      {notifications.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <p className="muted">No notifications yet.</p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {notifications.map((n) => (
          <div
            key={n.id}
            className="card"
            style={{
              opacity: n.is_read ? 0.65 : 1,
              borderLeft: n.is_read ? "3px solid var(--border)" : "3px solid var(--accent)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: n.is_read ? 400 : 700, marginBottom: 3 }}>
                  {typeLabel[n.type] ?? n.type} — {n.title}
                </p>
                {n.body && <p className="muted" style={{ fontSize: "0.88rem" }}>{n.body}</p>}
              </div>
              <p className="muted" style={{ fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                {new Date(n.created_at).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: Profile page
// ─────────────────────────────────────────────────────────────────────────────

type WalletChallenge = {
  challenge_id: string;
  message: string;
  expires_at: string;
  network: string;
  xrpl_testnet_json_rpc: string;
  xrpl_testnet_wss: string;
};

function ProfilePage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<any>(null);
  const [username, setUsername] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const [challenge, setChallenge] = useState<WalletChallenge | null>(null);
  const [wAddress, setWAddress] = useState("");
  const [wPub, setWPub] = useState("");
  const [wSig, setWSig] = useState("");
  const [walletOp, setWalletOp] = useState<null | "challenge" | "link" | "disconnect">(null);
  const [walletMsg, setWalletMsg] = useState("");

  const loadProfile = useCallback(() => {
    if (!token) return;
    void apiFetch<{ profile: any }>("/me/profile", token)
      .then((d) => {
        setProfile(d.profile);
        setUsername(d.profile.username ?? "");
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const saveUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(""); setLoading(true);
    try {
      await apiFetch("/me/username", token, { method: "POST", body: JSON.stringify({ username }) });
      setMsg("Username saved ✅");
      setProfile((p: any) => ({ ...p, username }));
    } catch (err: any) { setMsg(err.message ?? "Failed"); }
    finally { setLoading(false); }
  };

  const requestWalletChallenge = async () => {
    if (!token) return;
    setWalletMsg("");
    setWalletOp("challenge");
    try {
      const d = await apiFetch<WalletChallenge>("/me/profile/wallet/challenge", token, { method: "POST" });
      setChallenge(d);
      setWAddress("");
      setWPub("");
      setWSig("");
    } catch (e: any) {
      setWalletMsg(friendlyError(e));
    } finally {
      setWalletOp(null);
    }
  };

  const linkWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !challenge) return;
    setWalletMsg("");
    setWalletOp("link");
    try {
      await apiFetch("/me/profile/wallet", token, {
        method: "PATCH",
        body: JSON.stringify({
          challenge_id: challenge.challenge_id,
          address: wAddress.trim(),
          public_key: wPub.trim(),
          signature: wSig.trim().replace(/\s+/g, ""),
        }),
      });
      setChallenge(null);
      setWAddress("");
      setWPub("");
      setWSig("");
      loadProfile();
      setWalletMsg("");
    } catch (e: any) {
      setWalletMsg(friendlyError(e));
    } finally {
      setWalletOp(null);
    }
  };

  const disconnectWallet = async () => {
    if (!token) return;
    setWalletMsg("");
    setWalletOp("disconnect");
    try {
      await apiFetch("/me/profile/wallet", token, { method: "DELETE" });
      setChallenge(null);
      loadProfile();
      setWalletMsg("");
    } catch (e: any) {
      setWalletMsg(friendlyError(e));
    } finally {
      setWalletOp(null);
    }
  };

  const hasWallet = Boolean(profile?.xrpl_address);

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Profile</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p><span className="muted">Email:</span> <strong>{profile?.email}</strong></p>
        <p><span className="muted">Full name:</span> <strong>{profile?.full_name}</strong></p>
        <p><span className="muted">Role:</span> <strong>{profile?.role}</strong></p>
        <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "4px 0" }} />
        <div>
          <p className="muted" style={{ marginBottom: 6 }}>
            <strong style={{ color: "var(--text)" }}>Username</strong>
            {" — "}share this so others can send you money directly
          </p>
          {profile?.username ? (
            <p style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <code style={{ fontSize: "0.95rem", fontWeight: 600 }}>@{profile.username}</code>
              <CopyButton text={profile.username} />
            </p>
          ) : (
            <p className="muted" style={{ fontSize: "0.83rem", marginBottom: 8 }}>
              No username set — set one below so others can send you transfers by name.
            </p>
          )}
          <form onSubmit={saveUsername} style={{ display: "flex", gap: 10 }}>
            <input
              placeholder="e.g. alice_pay"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              pattern="[a-z0-9_]{3,30}"
              title="3-30 chars: lowercase letters, digits, underscores"
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={loading}>{loading ? "…" : "Save"}</button>
          </form>
          {msg && <p className={msg.includes("✅") ? "muted" : "error"}>{msg}</p>}
        </div>
        <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "4px 0" }} />
        <p style={{ wordBreak: "break-all" }}>
          <span className="muted" style={{ fontSize: "0.82rem" }}>User ID (for advanced use):</span>{" "}
          <code style={{ fontSize: "0.75rem", opacity: 0.7 }}>{profile?.id}</code>
          {profile?.id && <CopyButton text={profile.id} />}
        </p>
      </div>

      <div className="card" style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: "1.05rem" }}>XRPL wallet (optional)</h3>
        <p className="muted" style={{ margin: 0, fontSize: "0.88rem", lineHeight: 1.5 }}>
          Your LumixPay account stays primary (email and password). Optionally link an XRPL Testnet wallet to store a verified address for future on-chain settlement flows.{" "}
          <strong>Linking does not perform any on-chain transactions, deposits, or withdrawals in the current phase.</strong>
        </p>

        {hasWallet ? (
          <>
            <p style={{ margin: 0, lineHeight: 1.5 }}>
              <span className="muted">Connected XRPL wallet:</span>{" "}
              <code style={{ fontSize: "0.82rem", wordBreak: "break-all" }}>{profile.xrpl_address}</code>
              <CopyButton text={profile.xrpl_address} style={{ marginLeft: 8 }} />
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <span className="muted">Network:</span>
              <code className="muted" style={{ fontSize: "0.82rem" }}>xrpl_testnet</code>
              <span className="status-badge badge-active">XRPL Testnet</span>
            </div>
            {profile.xrpl_verified_at && (
              <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                Verified: {new Date(profile.xrpl_verified_at).toLocaleString()}
              </p>
            )}
            <button type="button" onClick={() => void disconnectWallet()} disabled={walletOp !== null} style={{ alignSelf: "flex-start" }}>
              {walletOp === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: 0, fontSize: "0.82rem", lineHeight: 1.45 }}>
              Sign the challenge with your Testnet account key (e.g. <code>ripple-keypairs</code> <code>sign(messageHex, privateKey)</code>). The server checks your signature against the address on XRPL Testnet.
            </p>
            <button type="button" onClick={() => void requestWalletChallenge()} disabled={walletOp !== null}>
              {walletOp === "challenge" ? "Loading…" : "Get verification message"}
            </button>
            {challenge && (
              <form onSubmit={linkWallet} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <p className="muted" style={{ margin: 0, fontSize: "0.78rem" }}>
                  Expires: {new Date(challenge.expires_at).toLocaleString()}
                </p>
                <label className="muted" style={{ fontSize: "0.82rem" }}>Challenge message (read-only)</label>
                <textarea
                  readOnly
                  value={challenge.message}
                  rows={8}
                  style={{ width: "100%", fontSize: "0.78rem", fontFamily: "inherit", resize: "vertical", background: "var(--surface)" }}
                />
                <div>
                  <CopyButton text={challenge.message} label="Copy message" style={{ marginLeft: 0 }} />
                </div>
                <label className="muted" style={{ fontSize: "0.82rem" }}>XRPL address</label>
                <input
                  placeholder="Classic address (r…)"
                  value={wAddress}
                  onChange={(e) => setWAddress(e.target.value)}
                  autoComplete="off"
                  required
                />
                <label className="muted" style={{ fontSize: "0.82rem" }}>Public key</label>
                <input
                  placeholder="Hex public key (ED… or 02/03…)"
                  value={wPub}
                  onChange={(e) => setWPub(e.target.value)}
                  autoComplete="off"
                  required
                />
                <label className="muted" style={{ fontSize: "0.82rem" }}>Signature</label>
                <input
                  placeholder="Hex signature from ripple-keypairs sign()"
                  value={wSig}
                  onChange={(e) => setWSig(e.target.value)}
                  autoComplete="off"
                  required
                />
                <button type="submit" disabled={walletOp !== null}>
                  {walletOp === "link" ? "Linking…" : "Link wallet"}
                </button>
              </form>
            )}
          </>
        )}
        {walletMsg ? (
          <p className="error" style={{ margin: 0 }}>{walletMsg}</p>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: Contacts page
// ─────────────────────────────────────────────────────────────────────────────

function ContactsPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<any[]>([]);
  const [identifier, setIdentifier] = useState("");
  const [nickname, setNickname] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const load = () =>
    apiFetch<{ contacts: any[] }>("/contacts", token)
      .then((d) => setContacts(d.contacts ?? []))
      .catch(() => {});

  useEffect(() => { void load(); }, [token]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(""); setLoading(true);
    try {
      await apiFetch("/contacts", token, { method: "POST", body: JSON.stringify({ identifier, nickname: nickname || undefined }) });
      setIdentifier(""); setNickname(""); setMsg("Contact added ✅"); void load();
    } catch (err: any) { setMsg(err.message ?? "Failed"); }
    finally { setLoading(false); }
  };

  const remove = async (id: string) => {
    try {
      await apiFetch(`/contacts/${id}`, token, { method: "DELETE" });
      setContacts((prev) => prev.filter((c) => c.id !== id));
    } catch (err: any) { setMsg(err.message ?? "Delete failed"); }
  };

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Contacts</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>
      <div className="card" style={{ marginBottom: 16 }}>
        <p className="muted" style={{ marginBottom: 10 }}>Add contact by email or username</p>
        <form onSubmit={add} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input placeholder="Email or @username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
          <input placeholder="Nickname (optional)" value={nickname} onChange={(e) => setNickname(e.target.value)} />
          <button type="submit" disabled={loading}>{loading ? "Adding…" : "Add Contact"}</button>
          {msg && <p className={msg.includes("✅") ? "muted" : "error"}>{msg}</p>}
        </form>
      </div>
      {contacts.length === 0 && <p className="muted">No contacts yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {contacts.map((c) => (
          <div key={c.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p style={{ fontWeight: 600 }}>{c.nickname ?? c.contact_full_name}</p>
              <p className="muted" style={{ fontSize: "0.82rem" }}>
                {c.contact_email}{c.contact_username ? ` · @${c.contact_username}` : ""}
              </p>
              <p className="muted" style={{ fontSize: "0.78rem" }}>ID: <code>{c.contact_id}</code><CopyButton text={c.contact_id} /></p>
            </div>
            <button onClick={() => remove(c.id)} style={{ background: "var(--danger)", fontSize: "0.8rem" }}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: Payment Links page
// ─────────────────────────────────────────────────────────────────────────────

function PaymentLinksPage() {
  const { token } = useAuth();
  const { accounts } = useBalances();
  const navigate = useNavigate();
  const [links, setLinks] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ asset_id: "", amount: "", description: "", max_uses: "" });
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [qrFor, setQrFor] = useState<string | null>(null);

  const load = () =>
    apiFetch<{ payment_links: any[] }>("/payment-links", token)
      .then((d) => setLinks(d.payment_links ?? []))
      .catch(() => {});

  useEffect(() => { void load(); }, [token]);
  useEffect(() => {
    if (!form.asset_id && accounts.length) setForm((f) => ({ ...f, asset_id: accounts[0]!.asset_id }));
  }, [accounts]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(""); setLoading(true);
    try {
      const payload: any = { asset_id: form.asset_id, description: form.description || undefined };
      if (form.amount) payload.amount = parseFloat(form.amount);
      if (form.max_uses) payload.max_uses = parseInt(form.max_uses, 10);
      await apiFetch("/payment-links", token, { method: "POST", body: JSON.stringify(payload) });
      setMsg("Created ✅"); setShowForm(false); setForm({ asset_id: accounts[0]?.asset_id ?? "", amount: "", description: "", max_uses: "" });
      void load();
    } catch (err: any) { setMsg(err.message ?? "Failed"); }
    finally { setLoading(false); }
  };

  const disable = async (id: string) => {
    try {
      await apiFetch(`/payment-links/${id}/disable`, token, { method: "PATCH" });
      void load();
    } catch (err: any) { alert(err.message); }
  };

  const payUrl = (id: string) => `${window.location.origin}/pay/${id}`;

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Payment Links</h2>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "+ New Link"}</button>
          <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
        </div>
      </header>

      {showForm && (
        <div className="card" style={{ marginBottom: 16 }}>
          <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label className="muted">Asset</label>
            <select value={form.asset_id} onChange={(e) => setForm((f) => ({ ...f, asset_id: e.target.value }))}>
              {accounts.map((a) => <option key={a.id} value={a.asset_id}>{a.asset.display_symbol}</option>)}
            </select>
            <label className="muted">Fixed amount (leave blank for payer to choose)</label>
            <input type="number" min="0.01" step="0.01" placeholder="e.g. 10.00" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
            <label className="muted">Description</label>
            <input placeholder="e.g. Coffee payment" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            <label className="muted">Max uses (blank = unlimited)</label>
            <input type="number" min="1" placeholder="e.g. 1" value={form.max_uses} onChange={(e) => setForm((f) => ({ ...f, max_uses: e.target.value }))} />
            <button type="submit" disabled={loading}>{loading ? "Creating…" : "Create Link"}</button>
            {msg && <p className={msg.includes("✅") ? "muted" : "error"}>{msg}</p>}
          </form>
        </div>
      )}

      {links.length === 0 && <p className="muted">No payment links yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {links.map((l) => (
          <div key={l.id} className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 600 }}>{l.description ?? "(no description)"}</p>
                <p className="muted">{l.display_symbol} · {l.amount ? `Fixed ${formatMoney(l.amount)}` : "Any amount"} · {l.uses_count}{l.max_uses ? `/${l.max_uses}` : ""} uses</p>
                <p className="muted" style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>{payUrl(l.id)}<CopyButton text={payUrl(l.id)} /></p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: "0.75rem", background: l.status === "active" ? "var(--success)" : "var(--border)", color: l.status === "active" ? "#fff" : undefined }}>{l.status}</span>
                <button onClick={() => setQrFor(qrFor === l.id ? null : l.id)} style={{ fontSize: "0.78rem", background: "var(--surface)", border: "1px solid var(--border)" }}>QR</button>
                {l.status === "active" && <button onClick={() => disable(l.id)} style={{ fontSize: "0.78rem", background: "var(--danger)" }}>Disable</button>}
              </div>
            </div>
            {qrFor === l.id && (
              <div style={{ marginTop: 12, display: "flex", justifyContent: "center", background: "#fff", padding: 12, borderRadius: 8 }}>
                <QRCode value={payUrl(l.id)} size={160} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: Public Pay page  /pay/:id
// ─────────────────────────────────────────────────────────────────────────────

function PayPage() {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [link, setLink] = useState<any>(null);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    apiFetch<{ payment_link: any }>(`/payment-links/pay/${id}`, null)
      .then((d) => setLink(d.payment_link))
      .catch((e: any) => setError(e.message ?? "Link not found"));
  }, [id]);

  const pay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) { navigate(`/login?next=/pay/${id}`); return; }
    setMsg(""); setLoading(true);
    try {
      const payload: any = {};
      if (!link.amount) payload.amount = parseFloat(amount);
      await apiFetch(`/payment-links/pay/${id}/claim`, token, { method: "POST", body: JSON.stringify(payload) });
      setMsg("Payment sent ✅");
    } catch (err: any) { setMsg(err.message ?? "Payment failed"); }
    finally { setLoading(false); }
  };

  const payUrl = `${window.location.origin}/pay/${id}`;

  if (error) return (
    <div style={{ maxWidth: 500, margin: "60px auto", padding: 24, textAlign: "center" }}>
      <p className="error" style={{ marginBottom: 20 }}>{error}</p>
      <Link to="/dashboard">← Dashboard</Link>
    </div>
  );

  if (!link) return <div style={{ padding: 60, textAlign: "center" }}><p className="muted">Loading…</p></div>;

  return (
    <div style={{ maxWidth: 480, margin: "60px auto", padding: "0 16px" }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ marginBottom: 4 }}>Pay via LumixPay</h2>
        <p><span className="muted">From:</span> <strong>{link.creator_name ?? link.creator_username ?? "Merchant"}</strong></p>
        {link.description && <p className="muted">{link.description}</p>}
        <p><span className="muted">Asset:</span> <strong>{link.display_symbol} – {link.display_name}</strong></p>
        {link.amount ? (
          <p style={{ fontSize: "1.4rem", fontWeight: 700 }}>{formatMoney(link.amount)} {link.display_symbol}</p>
        ) : (
          <p className="muted">Payer chooses amount</p>
        )}

        <div style={{ display: "flex", justifyContent: "center", background: "#fff", padding: 12, borderRadius: 8 }}>
          <QRCode value={payUrl} size={140} />
        </div>

        {msg ? (
          <p className={msg.includes("✅") ? "muted" : "error"} style={{ textAlign: "center", fontWeight: 600 }}>{msg}</p>
        ) : !user ? (
          <button onClick={() => navigate(`/login?next=/pay/${id}`)}>Sign in to Pay</button>
        ) : (
          <form onSubmit={pay} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {!link.amount && (
              <input type="number" min="0.01" step="0.01" placeholder="Enter amount" value={amount}
                onChange={(e) => setAmount(e.target.value)} required />
            )}
            <button type="submit" disabled={loading}>{loading ? "Sending…" : `Pay ${link.amount ? formatMoney(link.amount) : amount || ""} ${link.display_symbol}`}</button>
          </form>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6: Vouchers — Redeem, Buy, and My Vouchers
// ─────────────────────────────────────────────────────────────────────────────

function VouchersPage() {
  const { token } = useAuth();
  const { accounts, refresh } = useBalances();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"redeem" | "buy" | "mine">("redeem");

  // Redeem tab
  const [code, setCode] = useState("");
  const [redeemLoading, setRedeemLoading] = useState(false);
  const [redeemSuccess, setRedeemSuccess] = useState("");
  const [redeemError, setRedeemError] = useState("");

  // Buy tab — split success/error so FeedbackBanner type is always correct
  const [products, setProducts] = useState<any[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState("");
  const [buySuccess, setBuySuccess] = useState("");
  const [buyError, setBuyError] = useState("");
  const [buyLoading, setBuyLoading] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);

  // My vouchers tab
  const [myVouchers, setMyVouchers] = useState<any[]>([]);
  const [mineError, setMineError] = useState("");

  const loadMine = () => {
    apiFetch<{ vouchers: any[] }>("/vouchers/mine", token)
      .then((d) => { setMyVouchers(d.vouchers ?? []); setMineError(""); })
      .catch((err: any) => {
        console.error("[Vouchers] Failed to load my vouchers:", err);
        setMineError(friendlyError(err));
      });
  };

  useEffect(() => {
    setProductsLoading(true);
    apiFetch<{ products: any[] }>("/voucher-products", token)
      .then((d) => { setProducts(d.products ?? []); setProductsError(""); })
      .catch((err: any) => {
        console.error("[Vouchers] Failed to load products:", err);
        setProductsError("Could not load voucher products. Please try again.");
      })
      .finally(() => setProductsLoading(false));
    loadMine();
  }, [token]);

  const redeem = async (e: React.FormEvent) => {
    e.preventDefault();
    setRedeemSuccess(""); setRedeemError(""); setRedeemLoading(true);
    try {
      const d = await apiFetch<{ ok: boolean; credited: string }>("/vouchers/redeem", token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() },
        body: JSON.stringify({ code }),
      });
      setRedeemSuccess(`Redeemed — ${d.credited} credited to your balance.`);
      setCode(""); void refresh(); loadMine();
    } catch (err: any) {
      console.error("[Vouchers] Redeem failed:", err);
      setRedeemError(friendlyError(err));
    } finally { setRedeemLoading(false); }
  };

  const purchase = async (productId: string) => {
    setBuySuccess(""); setBuyError(""); setBuyLoading(productId); setNewCode(null);
    try {
      const d = await apiFetch<{ voucher: any; code: string }>("/vouchers/purchase", token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() },
        body: JSON.stringify({ product_id: productId }),
      });
      setNewCode(d.code);
      setBuySuccess("Voucher purchased successfully. Your code is ready to use or share.");
      void refresh(); loadMine();
    } catch (err: any) {
      console.error("[Vouchers] Purchase failed:", err);
      setBuyError(friendlyError(err));
    } finally { setBuyLoading(null); }
  };

  // Group products by asset symbol
  const productsByAsset: Record<string, any[]> = {};
  products.forEach((p) => {
    if (!productsByAsset[p.display_symbol]) productsByAsset[p.display_symbol] = [];
    productsByAsset[p.display_symbol]!.push(p);
  });

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Vouchers</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>

      <div className="tabs">
        <button className={`tab-btn${tab === "redeem" ? " active" : ""}`} onClick={() => setTab("redeem")}>Redeem Code</button>
        <button className={`tab-btn${tab === "buy" ? " active" : ""}`} onClick={() => setTab("buy")}>Buy Voucher</button>
        <button className={`tab-btn${tab === "mine" ? " active" : ""}`} onClick={() => setTab("mine")}>My Vouchers</button>
      </div>

      {tab === "redeem" && (
        <div className="card">
          <p className="muted" style={{ marginBottom: 14 }}>Enter your voucher code to top up your balance instantly.</p>
          <form onSubmit={redeem} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              placeholder="e.g. A1B2C3D4"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              style={{ fontFamily: "monospace", letterSpacing: "0.1em", textTransform: "uppercase" }}
              required
            />
            <button type="submit" disabled={redeemLoading}>{redeemLoading ? "Redeeming..." : "Redeem Voucher"}</button>
            {redeemSuccess && <FeedbackBanner type="success" message={redeemSuccess} />}
            {redeemError   && <FeedbackBanner type="error"   message={redeemError} />}
          </form>
        </div>
      )}

      {tab === "buy" && (
        <div>
          {newCode && (
            <div style={{ padding: 14, background: "var(--surface)", borderRadius: 10, border: "1px solid var(--border)", marginBottom: 16, textAlign: "center" }}>
              <p className="muted" style={{ marginBottom: 6 }}>Your voucher code:</p>
              <p style={{ fontFamily: "monospace", fontSize: "1.5rem", fontWeight: 700, letterSpacing: "0.15em" }}>{newCode}</p>
              <CopyButton text={newCode} />
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 8 }}>Balance deducted. You can redeem or share this code.</p>
            </div>
          )}
          {buySuccess && <FeedbackBanner type="success" message={buySuccess} />}
          {buyError   && <FeedbackBanner type="error"   message={buyError} />}

          {productsLoading && (
            <p className="muted" style={{ padding: "20px 0" }}>Loading products…</p>
          )}
          {!productsLoading && productsError && (
            <FeedbackBanner type="error" message={productsError} />
          )}
          {!productsLoading && !productsError && Object.entries(productsByAsset).map(([symbol, prods]) => (
            <div key={symbol} style={{ marginBottom: 20 }}>
              <h4 style={{ marginBottom: 10, color: "var(--muted)", fontSize: "0.82rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{symbol} Vouchers</h4>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
                {prods.map((p) => {
                  const userAcc = accounts.find((a) => a.asset_id === p.asset_id);
                  const canAfford = userAcc && parseFloat(String(userAcc.balance.available)) >= parseFloat(p.amount);
                  return (
                    <button
                      key={p.id}
                      onClick={() => purchase(p.id)}
                      disabled={buyLoading === p.id || !canAfford}
                      title={!canAfford ? "Insufficient balance" : undefined}
                      style={{
                        padding: "18px 10px", borderRadius: 10,
                        border: "1px solid var(--border)",
                        background: canAfford ? "var(--surface)" : "var(--bg)",
                        cursor: canAfford ? "pointer" : "not-allowed",
                        opacity: canAfford ? 1 : 0.5,
                        fontWeight: 700, fontSize: "1.15rem",
                      }}
                    >
                      {buyLoading === p.id ? "…" : `${symbol} ${formatMoney(p.amount)}`}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {!productsLoading && !productsError && products.length === 0 && (
            <p className="muted">No voucher products available. Ask an admin to add products to the catalog.</p>
          )}
        </div>
      )}

      {tab === "mine" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {mineError && <FeedbackBanner type="error" message={mineError} />}
          {!mineError && myVouchers.length === 0 && <p className="muted">No vouchers purchased yet.</p>}
          {myVouchers.map((v) => (
            <div key={v.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px" }}>
              <div>
                <p style={{ fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.1em" }}>{v.code}</p>
                <p className="muted">{v.display_symbol} · {formatMoney(v.gross_amount)}</p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <StatusBadge status={v.status} />
                <CopyButton text={v.code} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6: Admin Vouchers  /admin/vouchers
// ─────────────────────────────────────────────────────────────────────────────

function AdminVouchersPage() {
  const { token, user } = useAuth();
  const { accounts } = useBalances();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"codes" | "products">("codes");

  // ── Gift codes tab ──────────────────────────────────────────────────────────
  const [vouchers, setVouchers] = useState<any[]>([]);
  const [form, setForm] = useState({ asset_id: "", gross_amount: "20" });
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const loadCodes = () =>
    apiFetch<{ vouchers: any[] }>("/vouchers/admin", token)
      .then((d) => setVouchers(d.vouchers ?? []))
      .catch((err: any) => console.error("[AdminVouchers] Failed to load codes:", err));

  // ── Product catalog tab ─────────────────────────────────────────────────────
  const [products, setProducts] = useState<any[]>([]);
  const [prodForm, setProdForm] = useState({ asset_id: "", amount: "20" });
  const [prodMsg, setProdMsg] = useState("");
  const [prodLoading, setProdLoading] = useState(false);

  const loadProducts = () =>
    apiFetch<{ products: any[] }>("/vouchers/admin/products", token)
      .then((d) => setProducts(d.products ?? []))
      .catch((err: any) => console.error("[AdminVouchers] Failed to load products:", err));

  useEffect(() => { void loadCodes(); void loadProducts(); }, [token]);
  useEffect(() => {
    if (!form.asset_id && accounts.length) {
      setForm((f) => ({ ...f, asset_id: accounts[0]!.asset_id }));
      setProdForm((f) => ({ ...f, asset_id: accounts[0]!.asset_id }));
    }
  }, [accounts]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(""); setLoading(true);
    try {
      await apiFetch("/vouchers/admin", token, {
        method: "POST", body: JSON.stringify({ asset_id: form.asset_id, gross_amount: parseFloat(form.gross_amount) }),
      });
      setMsg("Voucher created ✅"); void loadCodes();
    } catch (err: any) { setMsg(err.message ?? "Failed"); }
    finally { setLoading(false); }
  };

  const disable = async (id: string) => {
    try { await apiFetch(`/vouchers/admin/${id}/disable`, token, { method: "POST" }); void loadCodes(); }
    catch (err: any) { alert(err.message); }
  };

  const createProduct = async (e: React.FormEvent) => {
    e.preventDefault(); setProdMsg(""); setProdLoading(true);
    try {
      await apiFetch("/vouchers/admin/products", token, {
        method: "POST",
        body: JSON.stringify({ asset_id: prodForm.asset_id, amount: parseFloat(prodForm.amount) }),
      });
      setProdMsg("Product added ✅"); void loadProducts();
    } catch (err: any) { setProdMsg(err.message ?? "Failed"); }
    finally { setProdLoading(false); }
  };

  const toggleProduct = async (id: string) => {
    try {
      await apiFetch(`/vouchers/admin/products/${id}/toggle`, token, { method: "PATCH" });
      void loadProducts();
    } catch (err: any) { alert(err.message); }
  };

  if (user?.role !== "admin") return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <p className="error" style={{ marginBottom: 16 }}>Access denied — admin only.</p>
      <Link to="/dashboard">← Back</Link>
    </div>
  );

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Admin — Vouchers</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>

      <div className="tabs" style={{ marginBottom: 16 }}>
        <button className={`tab-btn${tab === "codes" ? " active" : ""}`} onClick={() => setTab("codes")}>Gift Codes</button>
        <button className={`tab-btn${tab === "products" ? " active" : ""}`} onClick={() => setTab("products")}>Buy Catalog</button>
      </div>

      {tab === "codes" && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <p className="muted" style={{ marginBottom: 10 }}>Generate a single-use gift voucher code to share with a user</p>
            <form onSubmit={create} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <label className="muted" style={{ display: "block", marginBottom: 4 }}>Asset</label>
                <select value={form.asset_id} onChange={(e) => setForm((f) => ({ ...f, asset_id: e.target.value }))}>
                  {accounts.map((a) => <option key={a.id} value={a.asset_id}>{a.asset.display_symbol}</option>)}
                </select>
              </div>
              <div>
                <label className="muted" style={{ display: "block", marginBottom: 4 }}>Amount</label>
                <input type="number" min="0.01" step="0.01" value={form.gross_amount}
                  onChange={(e) => setForm((f) => ({ ...f, gross_amount: e.target.value }))} style={{ width: 100 }} />
              </div>
              <button type="submit" disabled={loading}>{loading ? "…" : "Create"}</button>
            </form>
            {msg && <p className={msg.includes("✅") ? "muted" : "error"} style={{ marginTop: 8 }}>{msg}</p>}
          </div>
          {vouchers.length === 0 && <p className="muted">No gift vouchers yet.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {vouchers.map((v) => (
              <div key={v.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px" }}>
                <div>
                  <p style={{ fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.1em" }}>{v.code}</p>
                  <p className="muted">{v.display_symbol} · {formatMoney(v.gross_amount)} · {v.status}</p>
                  {v.redeemed_by_user_id && <p className="muted" style={{ fontSize: "0.78rem" }}>Redeemed {new Date(v.redeemed_at).toLocaleString()}</p>}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <CopyButton text={v.code} />
                  {v.status === "active" && <button onClick={() => disable(v.id)} style={{ background: "var(--danger)", fontSize: "0.78rem" }}>Disable</button>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === "products" && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <p className="muted" style={{ marginBottom: 4 }}>Add a denomination to the purchasable voucher catalog visible to all users on the Buy Voucher tab.</p>
            <form onSubmit={createProduct} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
              <div>
                <label className="muted" style={{ display: "block", marginBottom: 4 }}>Asset</label>
                <select value={prodForm.asset_id} onChange={(e) => setProdForm((f) => ({ ...f, asset_id: e.target.value }))}>
                  {accounts.map((a) => <option key={a.id} value={a.asset_id}>{a.asset.display_symbol}</option>)}
                </select>
              </div>
              <div>
                <label className="muted" style={{ display: "block", marginBottom: 4 }}>Amount</label>
                <input type="number" min="0.01" step="0.01" value={prodForm.amount}
                  onChange={(e) => setProdForm((f) => ({ ...f, amount: e.target.value }))} style={{ width: 100 }} />
              </div>
              <button type="submit" disabled={prodLoading}>{prodLoading ? "…" : "Add product"}</button>
            </form>
            {prodMsg && <p className={prodMsg.includes("✅") ? "muted" : "error"} style={{ marginTop: 8 }}>{prodMsg}</p>}
          </div>
          {products.length === 0 && <p className="muted">No catalog products yet. Add denominations above so users can purchase vouchers.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {products.map((p) => (
              <div key={p.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px" }}>
                <div>
                  <p style={{ fontWeight: 700 }}>{p.display_symbol} {formatMoney(p.amount)}</p>
                  <p className="muted" style={{ fontSize: "0.78rem" }}>ID: {p.id.slice(0, 8)}…</p>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <StatusBadge status={p.is_active ? "active" : "disabled"} />
                  <button
                    onClick={() => toggleProduct(p.id)}
                    style={{ fontSize: "0.78rem", background: p.is_active ? "var(--danger)" : "var(--accent)" }}
                  >
                    {p.is_active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7: Recurring Payments
// ─────────────────────────────────────────────────────────────────────────────

function RecurringPage() {
  const { token } = useAuth();
  const { accounts } = useBalances();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<any[]>([]);
  const [subscriptions, setSubscriptions] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ asset_id: "", amount: "", interval: "monthly", day_of_month: "1", day_of_week: "1", description: "" });
  const [planId, setPlanId] = useState("");
  const [msg, setMsg] = useState("");
  const [subMsg, setSubMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const loadAll = () => {
    apiFetch<{ plans: any[] }>("/recurring/plans", token).then((d) => setPlans(d.plans ?? [])).catch(() => {});
    apiFetch<{ subscriptions: any[] }>("/recurring/subscriptions", token).then((d) => setSubscriptions(d.subscriptions ?? [])).catch(() => {});
  };

  useEffect(() => { void loadAll(); }, [token]);
  useEffect(() => {
    if (!form.asset_id && accounts.length) setForm((f) => ({ ...f, asset_id: accounts[0]!.asset_id }));
  }, [accounts]);

  const createPlan = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(""); setLoading(true);
    try {
      const payload: any = { asset_id: form.asset_id, amount: parseFloat(form.amount), interval: form.interval, description: form.description || undefined };
      if (form.interval === "monthly") payload.day_of_month = parseInt(form.day_of_month, 10);
      else payload.day_of_week = parseInt(form.day_of_week, 10);
      await apiFetch("/recurring/plans", token, { method: "POST", body: JSON.stringify(payload) });
      setMsg("Plan created ✅"); setShowForm(false); void loadAll();
    } catch (err: any) { setMsg(err.message ?? "Failed"); }
    finally { setLoading(false); }
  };

  const subscribe = async (e: React.FormEvent) => {
    e.preventDefault(); setSubMsg("");
    try {
      await apiFetch(`/recurring/plans/${planId}/subscribe`, token, { method: "POST", body: "{}" });
      setSubMsg("Subscribed ✅"); setPlanId(""); void loadAll();
    } catch (err: any) { setSubMsg(err.message ?? "Failed"); }
  };

  const cancel = async (id: string) => {
    try { await apiFetch(`/recurring/subscriptions/${id}`, token, { method: "DELETE" }); void loadAll(); }
    catch (err: any) { alert(err.message); }
  };

  const pause = async (id: string) => {
    try { await apiFetch(`/recurring/plans/${id}/pause`, token, { method: "PATCH" }); void loadAll(); }
    catch (err: any) { alert(err.message); }
  };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Recurring Payments</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>

      {/* Plans section */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h3>Plans I Created</h3>
        <button onClick={() => setShowForm(!showForm)} style={{ fontSize: "0.85rem" }}>{showForm ? "Cancel" : "+ New Plan"}</button>
      </div>
      {showForm && (
        <div className="card" style={{ marginBottom: 12 }}>
          <form onSubmit={createPlan} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: 1 }}>
                <label className="muted">Asset</label>
                <select value={form.asset_id} onChange={(e) => setForm((f) => ({ ...f, asset_id: e.target.value }))}>
                  {accounts.map((a) => <option key={a.id} value={a.asset_id}>{a.asset.display_symbol}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="muted">Amount per charge</label>
                <input type="number" min="0.01" step="0.01" placeholder="e.g. 9.99" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} required />
              </div>
              <div style={{ flex: 1 }}>
                <label className="muted">Interval</label>
                <select value={form.interval} onChange={(e) => setForm((f) => ({ ...f, interval: e.target.value }))}>
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
              {form.interval === "monthly" ? (
                <div style={{ flex: 1 }}>
                  <label className="muted">Day of month (1-28)</label>
                  <input type="number" min="1" max="28" value={form.day_of_month} onChange={(e) => setForm((f) => ({ ...f, day_of_month: e.target.value }))} required />
                </div>
              ) : (
                <div style={{ flex: 1 }}>
                  <label className="muted">Day of week (0=Sun)</label>
                  <input type="number" min="0" max="6" value={form.day_of_week} onChange={(e) => setForm((f) => ({ ...f, day_of_week: e.target.value }))} required />
                </div>
              )}
            </div>
            <input placeholder="Description (optional)" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            <button type="submit" disabled={loading}>{loading ? "Creating…" : "Create Plan"}</button>
            {msg && <p className={msg.includes("✅") ? "muted" : "error"}>{msg}</p>}
          </form>
        </div>
      )}
      {plans.length === 0 && <p className="muted">No plans created yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
        {plans.map((p) => (
          <div key={p.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p style={{ fontWeight: 600 }}>{p.description ?? "(no description)"}</p>
              <p className="muted">{p.display_symbol} · {formatMoney(p.amount)} · {p.interval} · {p.subscriber_count} subscribers</p>
              <p className="muted" style={{ fontSize: "0.78rem" }}>Plan ID: <code>{p.id}</code><CopyButton text={p.id} /></p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: "0.75rem", background: p.status === "active" ? "var(--success)" : "var(--border)", color: "#fff" }}>{p.status}</span>
              {p.status === "active" && <button onClick={() => pause(p.id)} style={{ fontSize: "0.78rem", background: "var(--border)" }}>Pause</button>}
            </div>
          </div>
        ))}
      </div>

      {/* Subscriptions section */}
      <h3 style={{ marginBottom: 12 }}>My Subscriptions</h3>
      <div className="card" style={{ marginBottom: 12 }}>
        <p className="muted" style={{ marginBottom: 8 }}>Subscribe by Plan ID</p>
        <form onSubmit={subscribe} style={{ display: "flex", gap: 10 }}>
          <input placeholder="Paste plan ID (UUID)" value={planId} onChange={(e) => setPlanId(e.target.value)} style={{ flex: 1 }} required />
          <button type="submit">Subscribe</button>
        </form>
        {subMsg && <p className={subMsg.includes("✅") ? "muted" : "error"} style={{ marginTop: 8 }}>{subMsg}</p>}
      </div>
      {subscriptions.length === 0 && <p className="muted">No active subscriptions.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {subscriptions.map((s) => (
          <div key={s.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p style={{ fontWeight: 600 }}>{s.plan_description ?? "(unnamed plan)"} — {s.creator_name}</p>
              <p className="muted">{s.display_symbol} · {formatMoney(s.plan_amount)} / {s.plan_interval}</p>
              <p className="muted" style={{ fontSize: "0.82rem" }}>Next charge: {new Date(s.next_run_at).toLocaleString()}</p>
            </div>
            {s.status === "active" && <button onClick={() => cancel(s.id)} style={{ background: "var(--danger)", fontSize: "0.8rem" }}>Cancel</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8: Developer page (in-app) — API keys + Webhooks
// ─────────────────────────────────────────────────────────────────────────────

function DeveloperPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [keyName, setKeyName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [webhookForm, setWebhookForm] = useState({ url: "", events: "" });
  const [msg, setMsg] = useState("");
  const [whMsg, setWhMsg] = useState("");
  const [newWebhookSecret, setNewWebhookSecret] = useState<string | null>(null);

  const loadKeys = () => apiFetch<{ api_keys: any[] }>("/me/api-keys", token).then((d) => setApiKeys(d.api_keys ?? [])).catch(() => {});
  const loadHooks = () => apiFetch<{ webhooks: any[]; available_events: string[] }>("/me/webhooks", token)
    .then((d) => { setWebhooks(d.webhooks ?? []); setEvents(d.available_events ?? []); }).catch(() => {});

  useEffect(() => { void loadKeys(); void loadHooks(); }, [token]);

  const createKey = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(""); setNewKey(null);
    try {
      const d = await apiFetch<{ api_key: any; key: string }>("/me/api-keys", token, { method: "POST", body: JSON.stringify({ name: keyName }) });
      setNewKey(d.key); setKeyName(""); void loadKeys();
    } catch (err: any) { setMsg(err.message ?? "Failed"); }
  };

  const revokeKey = async (id: string) => {
    try { await apiFetch(`/me/api-keys/${id}`, token, { method: "DELETE" }); void loadKeys(); }
    catch (err: any) { alert(err.message); }
  };

  const createWebhook = async (e: React.FormEvent) => {
    e.preventDefault(); setWhMsg(""); setNewWebhookSecret(null);
    const evts = webhookForm.events.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const d = await apiFetch<{ webhook: any }>("/me/webhooks", token, {
        method: "POST", body: JSON.stringify({ url: webhookForm.url, events: evts }),
      });
      setNewWebhookSecret((d as any).webhook?.secret ?? null);
      setWebhookForm({ url: "", events: "" }); void loadHooks();
    } catch (err: any) { setWhMsg(err.message ?? "Failed"); }
  };

  const disableWebhook = async (id: string) => {
    try { await apiFetch(`/me/webhooks/${id}`, token, { method: "DELETE" }); void loadHooks(); }
    catch (err: any) { alert(err.message); }
  };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Developer</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>

      <h3 style={{ marginBottom: 12 }}>API Keys</h3>
      <div className="card" style={{ marginBottom: 12 }}>
        <form onSubmit={createKey} style={{ display: "flex", gap: 10 }}>
          <input placeholder="Key name (e.g. production)" value={keyName} onChange={(e) => setKeyName(e.target.value)} style={{ flex: 1 }} required />
          <button type="submit">Create Key</button>
        </form>
        {msg && <p className="error" style={{ marginTop: 8 }}>{msg}</p>}
        {newKey && (
          <div style={{ marginTop: 10, padding: 10, background: "var(--bg)", borderRadius: 6 }}>
            <p className="muted" style={{ marginBottom: 6 }}>⚠ Copy now — shown only once!</p>
            <code style={{ wordBreak: "break-all", fontSize: "0.85rem" }}>{newKey}</code>
            <CopyButton text={newKey} />
          </div>
        )}
      </div>
      {apiKeys.length === 0 && <p className="muted" style={{ marginBottom: 20 }}>No API keys yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
        {apiKeys.map((k) => (
          <div key={k.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px" }}>
            <div>
              <p style={{ fontWeight: 600 }}>{k.name}</p>
              <p className="muted" style={{ fontSize: "0.82rem" }}>…{k.last4} · Created {new Date(k.created_at).toLocaleDateString()}</p>
              {k.revoked_at && <p className="muted" style={{ fontSize: "0.78rem", color: "var(--danger)" }}>Revoked</p>}
            </div>
            {!k.revoked_at && <button onClick={() => revokeKey(k.id)} style={{ background: "var(--danger)", fontSize: "0.78rem" }}>Revoke</button>}
          </div>
        ))}
      </div>

      <h3 style={{ marginBottom: 12 }}>Webhooks</h3>
      <div className="card" style={{ marginBottom: 12 }}>
        <form onSubmit={createWebhook} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input placeholder="Endpoint URL (https://...)" value={webhookForm.url} onChange={(e) => setWebhookForm((f) => ({ ...f, url: e.target.value }))} type="url" required />
          <input placeholder="Events (comma-separated, e.g. topup.completed,transfer.sent)" value={webhookForm.events} onChange={(e) => setWebhookForm((f) => ({ ...f, events: e.target.value }))} />
          <p className="muted" style={{ fontSize: "0.78rem" }}>Available: {events.join(", ")}</p>
          <button type="submit">Add Webhook</button>
          {whMsg && <p className="error">{whMsg}</p>}
          {newWebhookSecret && (
            <div style={{ padding: 10, background: "var(--bg)", borderRadius: 6 }}>
              <p className="muted" style={{ marginBottom: 6 }}>⚠ Signing secret — shown once:</p>
              <code style={{ wordBreak: "break-all", fontSize: "0.82rem" }}>{newWebhookSecret}</code>
              <CopyButton text={newWebhookSecret} />
            </div>
          )}
        </form>
      </div>
      {webhooks.length === 0 && <p className="muted">No webhooks yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {webhooks.map((w) => (
          <div key={w.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px" }}>
            <div>
              <p style={{ fontWeight: 600, wordBreak: "break-all" }}>{w.url}</p>
              <p className="muted" style={{ fontSize: "0.82rem" }}>{Array.isArray(w.events) ? w.events.join(", ") : w.events}</p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: "0.72rem", background: w.status === "active" ? "var(--success)" : "var(--border)", color: "#fff" }}>{w.status}</span>
              {w.status === "active" && <button onClick={() => disableWebhook(w.id)} style={{ fontSize: "0.78rem", background: "var(--danger)" }}>Disable</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: Admin Users  /admin/users
// ─────────────────────────────────────────────────────────────────────────────

function AdminUsersPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<any | null>(null);
  const [detail, setDetail] = useState<{ user: any; accounts: any[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    apiFetch<{ users: any[] }>(`/admin/users?search=${encodeURIComponent(search)}`, token)
      .then((d) => setUsers(d.users ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { void load(); }, [token]);

  const loadDetail = (id: string) => {
    apiFetch<{ user: any; accounts: any[] }>(`/admin/users/${id}`, token)
      .then((d) => setDetail(d))
      .catch(() => {});
    setSelected(id);
  };

  if (user?.role !== "admin") return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <p className="error" style={{ marginBottom: 16 }}>Access denied.</p>
      <Link to="/dashboard">← Back</Link>
    </div>
  );

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Admin — Users</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input placeholder="Search by email, name, or username…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => e.key === "Enter" && load()} />
        <button onClick={load}>{loading ? "…" : "Search"}</button>
      </div>
      {selected && detail && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h3>User Detail</h3>
            <button onClick={() => { setSelected(null); setDetail(null); }} style={{ background: "var(--border)" }}>Close</button>
          </div>
          <p><strong>{detail.user.full_name}</strong> · {detail.user.email} · {detail.user.role}</p>
          {detail.user.username && <p className="muted">@{detail.user.username}</p>}
          <p className="muted" style={{ fontSize: "0.78rem" }}>ID: {detail.user.id}</p>
          {detail.user.is_frozen && (
            <p style={{ color: "#dc2626", fontWeight: 600, fontSize: "0.82rem", marginTop: 4 }}>⚠ Account is frozen</p>
          )}
          {/* Admin actions */}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {detail.user.role !== "admin" && detail.user.role !== "system" && (
              <button
                style={{ fontSize: "0.78rem", background: "var(--accent)" }}
                onClick={async () => {
                  try {
                    await apiFetch(`/admin/users/${detail.user.id}/promote`, token, { method: "POST" });
                    loadDetail(detail.user.id);
                  } catch (e: any) { alert(e.message); }
                }}
              >Promote to Admin</button>
            )}
            {detail.user.role === "admin" && detail.user.id !== user?.id && (
              <button
                style={{ fontSize: "0.78rem", background: "var(--border)" }}
                onClick={async () => {
                  try {
                    await apiFetch(`/admin/users/${detail.user.id}/demote`, token, { method: "POST" });
                    loadDetail(detail.user.id);
                  } catch (e: any) { alert(e.message); }
                }}
              >Demote to User</button>
            )}
            {!detail.user.is_frozen ? (
              <button
                style={{ fontSize: "0.78rem", background: "#d97706" }}
                onClick={async () => {
                  if (!confirm("Freeze this account? They won't be able to transact.")) return;
                  try {
                    await apiFetch(`/admin/users/${detail.user.id}/freeze`, token, { method: "POST" });
                    loadDetail(detail.user.id);
                  } catch (e: any) { alert(e.message); }
                }}
              >Freeze Account</button>
            ) : (
              <button
                style={{ fontSize: "0.78rem", background: "var(--success)" }}
                onClick={async () => {
                  try {
                    await apiFetch(`/admin/users/${detail.user.id}/unfreeze`, token, { method: "POST" });
                    loadDetail(detail.user.id);
                  } catch (e: any) { alert(e.message); }
                }}
              >Unfreeze Account</button>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            {detail.accounts.map((a: any) => (
              <div key={a.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                <span>{a.display_symbol} {a.label}</span>
                <span><strong>{formatMoney(a.available)}</strong> avail · {formatMoney(a.locked)} locked</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {users.map((u) => (
          <div key={u.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", cursor: "pointer" }} onClick={() => loadDetail(u.id)}>
            <div>
              <p style={{ fontWeight: 600 }}>{u.full_name}</p>
              <p className="muted" style={{ fontSize: "0.82rem" }}>{u.email}{u.username ? ` · @${u.username}` : ""}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <span style={{ fontSize: "0.78rem", padding: "2px 8px", borderRadius: 10, background: u.role === "admin" ? "var(--accent)" : "var(--border)", color: "#fff" }}>{u.role}</span>
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 3 }}>Joined {new Date(u.created_at).toLocaleDateString()}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: Admin Ledger  /admin/ledger
// ─────────────────────────────────────────────────────────────────────────────

const ENTRY_TYPE_OPTIONS = ["","topup","transfer","fee","withdrawal_lock","withdrawal_unlock","withdrawal_settle","voucher","payment_link","recurring"];

function AdminLedgerPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<any[]>([]);
  const [filters, setFilters] = useState({ email: "", from: "", to: "", entry_type: "" });
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    const q = new URLSearchParams();
    if (filters.email) q.set("email", filters.email);
    if (filters.from)  q.set("from",  filters.from);
    if (filters.to)    q.set("to",    filters.to);
    if (filters.entry_type) q.set("entry_type", filters.entry_type);
    apiFetch<{ entries: any[] }>(`/admin/ledger?${q}`, token)
      .then((d) => setEntries(d.entries ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { void load(); }, [token]);

  if (user?.role !== "admin") return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <p className="error" style={{ marginBottom: 16 }}>Access denied.</p>
      <Link to="/dashboard">← Back</Link>
    </div>
  );

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Admin — Ledger</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <input placeholder="User email" value={filters.email} onChange={(e) => setFilters((f) => ({ ...f, email: e.target.value }))} style={{ width: 200 }} />
        <input type="datetime-local" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} title="From" />
        <input type="datetime-local" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} title="To" />
        <select value={filters.entry_type} onChange={(e) => setFilters((f) => ({ ...f, entry_type: e.target.value }))}>
          {ENTRY_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t || "(all types)"}</option>)}
        </select>
        <button onClick={load}>{loading ? "…" : "Filter"}</button>
      </div>
      {entries.length === 0 && !loading && <p className="muted">No entries.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {entries.map((e) => (
          <div key={e.id} className="card" style={{ padding: "8px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p style={{ fontWeight: 600, fontSize: "0.9rem" }}>{e.entry_type}</p>
              <p className="muted" style={{ fontSize: "0.78rem" }}>{new Date(e.created_at).toLocaleString()}</p>
            </div>
            <p style={{ fontWeight: 700 }}>{formatMoney(e.amount)} {e.currency_code}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: Admin Alerts  /admin/alerts
// ─────────────────────────────────────────────────────────────────────────────

function AdminAlertsPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<any[]>([]);
  const [filterResolved, setFilterResolved] = useState("false");

  const load = () =>
    apiFetch<{ alerts: any[] }>(`/admin/alerts?resolved=${filterResolved}`, token)
      .then((d) => setAlerts(d.alerts ?? []))
      .catch(() => {});

  useEffect(() => { void load(); }, [token, filterResolved]);

  const resolve = async (id: string) => {
    try { await apiFetch(`/admin/alerts/${id}/resolve`, token, { method: "POST" }); void load(); }
    catch (err: any) { alert(err.message); }
  };

  if (user?.role !== "admin") return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <p className="error" style={{ marginBottom: 16 }}>Access denied.</p>
      <Link to="/dashboard">← Back</Link>
    </div>
  );

  const severityColor = (s: string) => s === "critical" ? "#dc2626" : s === "warning" ? "#d97706" : "var(--muted)";

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Admin — Alerts</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
        <span className="muted">Show:</span>
        {["false","true",""].map((v) => (
          <button key={v} onClick={() => setFilterResolved(v)} style={{ fontSize: "0.82rem", padding: "4px 12px", background: filterResolved === v ? "var(--accent)" : "var(--surface)", border: "1px solid var(--border)" }}>
            {v === "false" ? "Unresolved" : v === "true" ? "Resolved" : "All"}
          </button>
        ))}
        <button onClick={load} style={{ fontSize: "0.82rem", padding: "4px 12px", background: "var(--border)" }}>↻</button>
      </div>
      {alerts.length === 0 && <p className="muted">No alerts.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {alerts.map((a) => (
          <div key={a.id} className="card" style={{ borderLeft: `3px solid ${severityColor(a.severity)}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <p style={{ fontWeight: 600 }}>{a.title}</p>
                {a.body && <p className="muted" style={{ fontSize: "0.85rem" }}>{a.body}</p>}
                <p className="muted" style={{ fontSize: "0.78rem" }}>{a.type} · {a.severity} · {new Date(a.created_at).toLocaleString()}</p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: "0.75rem", padding: "2px 8px", borderRadius: 10, background: a.is_resolved ? "var(--border)" : severityColor(a.severity), color: "#fff" }}>
                  {a.is_resolved ? "resolved" : a.severity}
                </span>
                {!a.is_resolved && <button onClick={() => resolve(a.id)} style={{ fontSize: "0.78rem", background: "var(--success)" }}>Resolve</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exchange page  /exchange
// ─────────────────────────────────────────────────────────────────────────────

function ExchangePage() {
  const { token } = useAuth();
  const { accounts, refresh } = useBalances();
  const navigate = useNavigate();
  const [rates, setRates] = useState<any[]>([]);
  const [fromAssetId, setFromAssetId] = useState("");
  const [toAssetId, setToAssetId] = useState("");
  const [amount, setAmount] = useState("10");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"form" | "confirm" | "success">("form");
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [estimate, setEstimate] = useState<string | null>(null);
  const [estimateRaw, setEstimateRaw] = useState<{ est: string; toSymbol: string } | null>(null);

  useEffect(() => {
    apiFetch<{ rates: any[] }>("/fx-rates/all", token)
      .then((d) => setRates(d.rates ?? []))
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!fromAssetId && accounts.length > 0) setFromAssetId(accounts[0]!.asset_id);
    if (!toAssetId && accounts.length > 1) setToAssetId(accounts[1]!.asset_id);
    else if (!toAssetId && accounts.length === 1) {
      const other = accounts.find((a) => a.asset_id !== fromAssetId);
      if (other) setToAssetId(other.asset_id);
    }
  }, [accounts, fromAssetId, toAssetId]);

  useEffect(() => {
    const fromAcc_ = accounts.find((a) => a.asset_id === fromAssetId);
    const available_ = fromAcc_ ? parseFloat(String(fromAcc_.balance.available)) : null;
    if (!fromAssetId || !toAssetId || !amount || fromAssetId === toAssetId) {
      console.log("[Exchange] estimate skipped", { fromAssetId, toAssetId, amount, sameAsset: fromAssetId === toAssetId });
      setEstimate(null); setEstimateRaw(null); return;
    }
    const rate = rates.find((r) => r.base_asset_id === fromAssetId && r.quote_asset_id === toAssetId);
    const est = rate ? (parseFloat(amount) * parseFloat(rate.rate)).toFixed(2) : null;
    const toSymbol = accounts.find((a) => a.asset_id === toAssetId)?.asset.display_symbol ?? "";
    const canReview = !!est && !!available_ && parseFloat(amount) <= available_;
    console.log("[Exchange] state", {
      fromAssetId, toAssetId, amount,
      available: available_,
      rateFound: !!rate,
      preview: est ? `${est} ${toSymbol}` : null,
      canReview,
    });
    if (!rate) { setEstimate(null); setEstimateRaw(null); return; }
    setEstimate(`~${est} ${toSymbol}`);
    setEstimateRaw({ est: est!, toSymbol });
  }, [fromAssetId, toAssetId, amount, rates, accounts]);

  const handleConvert = async () => {
    setErrorMsg(""); setLoading(true);

    const payload = {
      from_asset_id: fromAssetId,
      to_asset_id:   toAssetId,
      amount:        parseFloat(amount),
    };
    const idempotencyKey = generateIdempotencyKey();
    console.log("[Exchange] Sending POST /convert", {
      endpoint: "/convert",
      method:   "POST",
      payload,
      "Idempotency-Key": `present (${idempotencyKey.slice(0, 8)}…)`,
    });

    try {
      const d = await apiFetch<{ conversion: any }>("/convert", token, {
        method:  "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body:    JSON.stringify(payload),
      });
      await refresh();
      setSuccessMsg(`${d.conversion.from_amount} ${d.conversion.from_code} converted to ${d.conversion.to_amount} ${d.conversion.to_code}`);
      setStep("success");
    } catch (err: any) {
      console.error("[Exchange] POST /convert failed:", err);
      const msg = friendlyError(err);
      setErrorMsg(msg);
      setStep("form");
    } finally {
      setLoading(false);
    }
  };

  const fromAcc = accounts.find((a) => a.asset_id === fromAssetId);
  const fromSymbol = fromAcc?.asset.display_symbol ?? "";
  const exceedsBalance = fromAcc && parseFloat(amount) > parseFloat(String(fromAcc.balance.available));

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Currency Exchange</h2>
          <p className="muted" style={{ fontSize: "0.78rem" }}>Convert between RLUSD and EURQ at current rates</p>
        </div>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>

      {errorMsg && <FeedbackBanner type="error" message={errorMsg} />}

      {step === "form" && (
        <div className="card">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="form-field">
              <label className="form-label">From</label>
              <select
                value={fromAssetId}
                onChange={(e) => {
                  const newFrom = e.target.value;
                  setFromAssetId(newFrom);
                  // If the new source equals the current destination, auto-pick a different destination
                  if (newFrom === toAssetId) {
                    const other = accounts.find((a) => a.asset_id !== newFrom);
                    if (other) setToAssetId(other.asset_id);
                  }
                }}
                required
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.asset_id}>
                    {a.asset.display_symbol} &mdash; {formatMoney(a.balance.available)} available
                  </option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label className="form-label">Amount</label>
              <input
                type="number" min="0.01" step="0.01" value={amount}
                onChange={(e) => setAmount(e.target.value)} required
              />
              {exceedsBalance && (
                <span className="form-hint" style={{ color: "#f87171" }}>Exceeds your available balance</span>
              )}
            </div>

            <div className="form-field">
              <label className="form-label">To</label>
              <select value={toAssetId} onChange={(e) => setToAssetId(e.target.value)} required>
                {accounts.filter((a) => a.asset_id !== fromAssetId).map((a) => (
                  <option key={a.id} value={a.asset_id}>{a.asset.display_symbol}</option>
                ))}
              </select>
            </div>

            {estimate && (
              <div className="confirm-panel" style={{ margin: 0 }}>
                <ConfirmRow label="You send" value={`${amount} ${fromSymbol}`} />
                <ConfirmRow label="You receive" value={estimate} highlight />
              </div>
            )}
            {!estimate && fromAssetId && toAssetId && fromAssetId !== toAssetId && (
              <FeedbackBanner type="warning" message="No exchange rate available for this pair." />
            )}

            <button
              onClick={() => setStep("confirm")}
              disabled={fromAssetId === toAssetId || !estimate || !!exceedsBalance}
            >
              Review Exchange
            </button>
          </div>
        </div>
      )}

      {step === "confirm" && estimateRaw && (
        <div className="card">
          <h3 style={{ marginBottom: 4, fontSize: "1rem" }}>Confirm Exchange</h3>
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 14 }}>Rate may vary slightly at execution time.</p>
          <div className="confirm-panel">
            <ConfirmRow label="You send" value={`${amount} ${fromSymbol}`} />
            <ConfirmRow label="You receive (~)" value={`${estimateRaw.est} ${estimateRaw.toSymbol}`} highlight />
            <ConfirmRow label="Settlement" value={<span className="settle-tag">Internal</span>} />
          </div>
          <InlineHelp>This is an internal conversion between your LumixPay accounts. It settles instantly.</InlineHelp>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={() => setStep("form")} style={{ background: "var(--surface)", border: "1px solid var(--border)", flex: 1 }}>
              Edit
            </button>
            <button onClick={handleConvert} disabled={loading} style={{ flex: 2 }}>
              {loading ? "Converting..." : "Confirm Exchange"}
            </button>
          </div>
        </div>
      )}

      {step === "success" && (
        <div className="card">
          <div className="success-screen">
            <div className="success-icon">&#10003;</div>
            <div className="success-title">Conversion complete</div>
            <div className="success-sub">{successMsg}</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <button onClick={() => { setStep("form"); setSuccessMsg(""); setErrorMsg(""); }} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                Convert again
              </button>
              <button onClick={() => navigate("/dashboard")}>Back to dashboard</button>
            </div>
          </div>
        </div>
      )}

      {rates.length > 0 && step === "form" && (
        <div className="card" style={{ marginTop: 16 }}>
          <h4 style={{ marginBottom: 12, color: "var(--muted)", fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Current Rates
          </h4>
          {rates.map((r) => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: "0.875rem" }}>
              <span className="muted">1 {r.base_symbol}</span>
              <strong>{parseFloat(r.rate).toFixed(6)} {r.quote_symbol}</strong>
            </div>
          ))}
          <p className="muted" style={{ fontSize: "0.72rem", marginTop: 10 }}>Rates are set by admin and may update periodically.</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Developers page  /admin/developers
// ─────────────────────────────────────────────────────────────────────────────

function AdminDevelopersPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [devs, setDevs] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [detail, setDetail] = useState<{ user: any; apiKeys: any[]; webhooks: any[]; usage: any[] } | null>(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(() => {
    setLoading(true);
    apiFetch<{ developers: any[] }>("/admin/developers", token)
      .then((d) => setDevs(d.developers ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  const loadDetail = useCallback((userId: string) => {
    apiFetch<any>(`/admin/developers/${userId}`, token)
      .then((d) => setDetail(d))
      .catch(() => {});
  }, [token]);

  useEffect(() => { void loadList(); }, [loadList]);

  const revokeKey = async (keyId: string) => {
    setMsg("");
    try {
      await apiFetch(`/admin/api-keys/${keyId}/revoke`, token, { method: "POST" });
      setMsg("API key revoked ✅");
      if (selected) void loadDetail(selected.id);
    } catch (e: any) { setMsg(e.message ?? "Failed"); }
  };

  const disableWebhook = async (whId: string) => {
    setMsg("");
    try {
      await apiFetch(`/admin/webhooks/${whId}/disable`, token, { method: "POST" });
      setMsg("Webhook disabled ✅");
      if (selected) void loadDetail(selected.id);
    } catch (e: any) { setMsg(e.message ?? "Failed"); }
  };

  if (user?.role !== "admin") return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <p className="error" style={{ marginBottom: 16 }}>Access denied — admin only.</p>
      <Link to="/dashboard">← Back</Link>
    </div>
  );

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Admin — Developer Oversight</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>
      <p className="muted" style={{ marginBottom: 20 }}>Users with API keys or webhooks. Click a row to view details.</p>
      {msg && <p className={msg.includes("✅") ? "muted" : "error"} style={{ marginBottom: 12 }}>{msg}</p>}

      {/* Developer list */}
      <div className="card" style={{ marginBottom: 20, overflowX: "auto" }}>
        {loading ? <p className="muted" style={{ padding: 16 }}>Loading…</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Email", "Name", "Active Keys", "Active Webhooks", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "var(--muted)", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {devs.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: 16, color: "var(--muted)" }}>No developers yet.</td></tr>
              ) : devs.map((d) => (
                <tr key={d.id} style={{ borderBottom: "1px solid var(--border)", cursor: "pointer", background: selected?.id === d.id ? "var(--bg)" : undefined }}
                  onClick={() => { setSelected(d); setDetail(null); void loadDetail(d.id); }}>
                  <td style={{ padding: "9px 12px" }}>{d.email}</td>
                  <td style={{ padding: "9px 12px" }}>{d.full_name}</td>
                  <td style={{ padding: "9px 12px" }}>
                    <span style={{ background: "rgba(59,130,246,.15)", color: "#60a5fa", borderRadius: 12, padding: "2px 8px", fontSize: "0.78rem" }}>
                      {d.active_keys} / {d.total_keys}
                    </span>
                  </td>
                  <td style={{ padding: "9px 12px" }}>
                    <span style={{ background: "rgba(34,197,94,.12)", color: "#4ade80", borderRadius: 12, padding: "2px 8px", fontSize: "0.78rem" }}>
                      {d.active_webhooks} / {d.total_webhooks}
                    </span>
                  </td>
                  <td style={{ padding: "9px 12px", color: "var(--accent)", fontSize: "0.78rem" }}>View →</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Developer detail panel */}
      {selected && (
        <div className="card">
          <h3 style={{ fontSize: "1rem", marginBottom: 4 }}>{detail?.user?.full_name ?? selected.full_name}</h3>
          <p className="muted" style={{ marginBottom: 16, fontSize: "0.82rem" }}>{detail?.user?.email ?? selected.email}</p>

          {!detail ? <p className="muted">Loading…</p> : (
            <>
              {/* API Keys */}
              <h4 style={{ fontSize: "0.88rem", marginBottom: 10 }}>API Keys ({detail.apiKeys.length})</h4>
              {detail.apiKeys.length === 0 ? (
                <p className="muted" style={{ marginBottom: 16, fontSize: "0.82rem" }}>None.</p>
              ) : (
                <div style={{ marginBottom: 20, display: "flex", flexDirection: "column", gap: 8 }}>
                  {detail.apiKeys.map((k) => (
                    <div key={k.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--bg)", borderRadius: 8 }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{k.name}</span>
                        <span className="muted" style={{ marginLeft: 10, fontSize: "0.78rem" }}>…{k.last4}</span>
                        {k.revoked_at && <span style={{ marginLeft: 8, fontSize: "0.72rem", color: "var(--error,#ef4444)" }}>REVOKED</span>}
                      </div>
                      {!k.revoked_at && (
                        <button
                          onClick={() => revokeKey(k.id)}
                          style={{ fontSize: "0.75rem", padding: "3px 10px", background: "rgba(239,68,68,.12)", border: "1px solid rgba(239,68,68,.3)", color: "#ef4444" }}
                        >Revoke</button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Webhooks */}
              <h4 style={{ fontSize: "0.88rem", marginBottom: 10 }}>Webhooks ({detail.webhooks.length})</h4>
              {detail.webhooks.length === 0 ? (
                <p className="muted" style={{ marginBottom: 16, fontSize: "0.82rem" }}>None.</p>
              ) : (
                <div style={{ marginBottom: 20, display: "flex", flexDirection: "column", gap: 8 }}>
                  {detail.webhooks.map((w) => (
                    <div key={w.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--bg)", borderRadius: 8 }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: "0.82rem", wordBreak: "break-all" }}>{w.url}</span>
                        <span className="muted" style={{ marginLeft: 8, fontSize: "0.75rem" }}>
                          {w.delivery_count} deliveries · last: {w.last_delivery_status ?? "—"}
                        </span>
                        {w.status === "disabled" && (
                          <span style={{ marginLeft: 8, fontSize: "0.72rem", color: "var(--error,#ef4444)" }}>DISABLED</span>
                        )}
                      </div>
                      {w.status === "active" && (
                        <button
                          onClick={() => disableWebhook(w.id)}
                          style={{ fontSize: "0.75rem", padding: "3px 10px", background: "rgba(239,68,68,.12)", border: "1px solid rgba(239,68,68,.3)", color: "#ef4444" }}
                        >Disable</button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Usage stats */}
              {detail.usage.length > 0 && (
                <>
                  <h4 style={{ fontSize: "0.88rem", marginBottom: 10 }}>API Usage (top routes)</h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {detail.usage.map((u, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 12px", background: "var(--bg)", borderRadius: 6, fontSize: "0.8rem" }}>
                        <span><span className="muted">{u.method}</span> {u.route}</span>
                        <span className="muted">{u.requests} reqs · {u.avg_ms}ms avg</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Treasury page  /admin/treasury
// ─────────────────────────────────────────────────────────────────────────────

function AdminTreasuryPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [limits, setLimits] = useState<any[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ max_supply: "", current_supply: "" });
  const [msg, setMsg] = useState("");

  // ── Revenue analytics ────────────────────────────────────────────────────
  const [revPeriod, setRevPeriod] = useState<"today"|"7d"|"30d"|"all">("30d");
  const [revenue, setRevenue] = useState<{
    bankRevenue: string; cryptoRevenue: string; totalRevenue: string;
    breakdown: Record<string,number>;
  } | null>(null);

  const loadRevenue = useCallback((p: string) => {
    apiFetch<any>(`/admin/treasury/revenue?period=${p}`, token)
      .then((d) => setRevenue(d))
      .catch(() => {});
  }, [token]);

  const load = () =>
    apiFetch<{ limits: any[] }>("/admin/treasury", token)
      .then((d) => setLimits(d.limits ?? []))
      .catch(() => {});

  useEffect(() => { void load(); void loadRevenue(revPeriod); }, [token]);
  useEffect(() => { void loadRevenue(revPeriod); }, [revPeriod]);

  const save = async (assetId: string) => {
    setMsg("");
    try {
      const payload: any = {};
      if (editForm.max_supply) payload.max_supply = parseFloat(editForm.max_supply);
      if (editForm.current_supply) payload.current_supply = parseFloat(editForm.current_supply);
      await apiFetch(`/admin/treasury/${assetId}`, token, { method: "PUT", body: JSON.stringify(payload) });
      setMsg("Updated ✅"); setEditing(null); void load();
    } catch (err: any) { setMsg(err.message ?? "Failed"); }
  };

  if (user?.role !== "admin") return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <p className="error" style={{ marginBottom: 16 }}>Access denied — admin only.</p>
      <Link to="/dashboard">← Back</Link>
    </div>
  );

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Admin — Treasury</h2>
        <button onClick={() => navigate("/dashboard")} style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>Back</button>
      </header>
      <p className="muted" style={{ marginBottom: 16 }}>
        Manage token inventory per asset. <strong>Available Inventory</strong> decreases on every topup or admin-voucher redemption. Admin restocks by editing the value directly.
      </p>

      {/* ── Revenue Dashboard ─────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          <h3 style={{ fontSize: "1rem" }}>Platform Revenue</h3>
          <div style={{ display: "flex", gap: 6 }}>
            {(["today", "7d", "30d", "all"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setRevPeriod(p)}
                style={{
                  fontSize: "0.75rem", padding: "3px 10px",
                  background: revPeriod === p ? "var(--accent)" : "var(--surface)",
                  border: `1px solid ${revPeriod === p ? "var(--accent)" : "var(--border)"}`,
                  color: revPeriod === p ? "#fff" : undefined,
                }}
              >{p}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
          {/* Bank revenue */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "14px 16px" }}>
            <p className="muted" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>🏦 Bank Revenue</p>
            <p style={{ fontWeight: 700, fontSize: "1.25rem" }}>{revenue ? formatMoney(revenue.bankRevenue) : "…"}</p>
            <p className="muted" style={{ fontSize: "0.7rem", marginTop: 4 }}>Topup fees + Voucher fees</p>
          </div>

          {/* Crypto revenue */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "14px 16px" }}>
            <p className="muted" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>⛓ Crypto Revenue</p>
            <p style={{ fontWeight: 700, fontSize: "1.25rem" }}>{revenue ? formatMoney(revenue.cryptoRevenue) : "…"}</p>
            <p className="muted" style={{ fontSize: "0.7rem", marginTop: 4 }}>Transfer fees + Withdrawal fees</p>
          </div>

          {/* Total */}
          <div style={{ background: "linear-gradient(135deg,rgba(124,58,237,.15),rgba(59,130,246,.15))", borderRadius: 10, padding: "14px 16px", border: "1px solid rgba(124,58,237,.25)" }}>
            <p className="muted" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>✨ Total Revenue</p>
            <p style={{ fontWeight: 700, fontSize: "1.25rem" }}>{revenue ? formatMoney(revenue.totalRevenue) : "…"}</p>
            <p className="muted" style={{ fontSize: "0.7rem", marginTop: 4 }}>Combined platform revenue</p>
          </div>
        </div>

        {revenue?.breakdown && Object.keys(revenue.breakdown).length > 0 && (
          <div style={{ marginTop: 14 }}>
            <p className="muted" style={{ fontSize: "0.72rem", marginBottom: 8 }}>Breakdown by source</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {Object.entries(revenue.breakdown).map(([type, amt]) => (
                <span key={type} style={{ fontSize: "0.75rem", background: "var(--bg)", padding: "3px 10px", borderRadius: 20, border: "1px solid var(--border)" }}>
                  <span className="muted">{type}: </span>{formatMoney(String(amt))}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {msg && <p className={msg.includes("✅") ? "muted" : "error"} style={{ marginBottom: 12 }}>{msg}</p>}

      <h3 style={{ fontSize: "1rem", marginBottom: 12 }}>Inventory Limits</h3>
      {limits.map((l) => (
        <div key={l.asset_id} className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ fontSize: "1.05rem" }}>{l.display_symbol} — {l.display_name}</h3>
            <button
              onClick={() => { setEditing(l.asset_id); setEditForm({ max_supply: l.max_supply, current_supply: l.current_supply }); }}
              style={{ fontSize: "0.82rem", background: "var(--surface)", border: "1px solid var(--border)" }}
            >Edit</button>
          </div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div>
              <p className="muted" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Available Inventory</p>
              <p style={{ fontWeight: 700, fontSize: "1.2rem", color: parseFloat(l.current_supply) < parseFloat(l.max_supply) * 0.1 ? "var(--error,#ef4444)" : undefined }}>
                {formatMoney(l.current_supply)}
              </p>
            </div>
            <div>
              <p className="muted" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Total Capacity</p>
              <p style={{ fontWeight: 700, fontSize: "1.2rem" }}>{formatMoney(l.max_supply)}</p>
            </div>
            <div>
              <p className="muted" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Depleted</p>
              <p style={{ fontWeight: 700, fontSize: "1.2rem" }}>
                {parseFloat(l.max_supply) > 0
                  ? (((parseFloat(l.max_supply) - parseFloat(l.current_supply)) / parseFloat(l.max_supply)) * 100).toFixed(1)
                  : "0.0"}%
              </p>
            </div>
          </div>
          {editing === l.asset_id && (
            <div style={{ marginTop: 14, padding: 12, background: "var(--bg)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1 }}>
                  <label className="muted" style={{ display: "block", marginBottom: 4, fontSize: "0.78rem" }}>Max Supply</label>
                  <input type="number" min="0" step="0.01" value={editForm.max_supply}
                    onChange={(e) => setEditForm((f) => ({ ...f, max_supply: e.target.value }))} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="muted" style={{ display: "block", marginBottom: 4, fontSize: "0.78rem" }}>Available Inventory (restock)</label>
                  <input type="number" min="0" step="0.01" value={editForm.current_supply}
                    onChange={(e) => setEditForm((f) => ({ ...f, current_supply: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => save(l.asset_id)}>Save</button>
                <button onClick={() => setEditing(null)} style={{ background: "var(--border)" }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AppShell — sidebar layout wrapper for all authenticated pages
// ─────────────────────────────────────────────────────────────────────────────

function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout, token } = useAuth();
  const { unreadCount, setUnreadFromSSE, setSseActive } = useNotifications();
  const { setAccountsFromSSE } = useBalances();
  const { addToast } = useToast();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [installAvailable, setInstallAvailable] = useState(canInstall);
  const [showIosModal, setShowIosModal] = useState(false);
  const [pushOn, setPushOn] = useState(pushEnabled);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushUiStatus>("DISABLED");

  // Close mobile nav on route change
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // React to deferred install prompt becoming available (e.g. after a visit)
  useEffect(() => {
    const onAvailable = () => setInstallAvailable(true);
    const onInstalled = () => setInstallAvailable(false);
    window.addEventListener("pwa-install-available", onAvailable);
    window.addEventListener("pwa-installed", onInstalled);
    return () => {
      window.removeEventListener("pwa-install-available", onAvailable);
      window.removeEventListener("pwa-installed", onInstalled);
    };
  }, []);

  // Initial push status resolution (permission + actual subscription)
  useEffect(() => {
    void getPushStatus()
      .then((s) => { setPushStatus(s); setPushOn(s === "ENABLED"); })
      .catch(() => {});
  }, []);

  // ── Real-time SSE wiring ───────────────────────────────────────────────────
  useStream(token, {
    "connected": () => setSseActive(true),
    "balances.updated": (data) => {
      if (Array.isArray(data?.accounts)) setAccountsFromSSE(data.accounts);
    },
    "notifications.unread": (data) => {
      if (typeof data?.count === "number") setUnreadFromSSE(data.count);
    },
  });

  const isActive = (to: string) => pathname === to || (to !== "/dashboard" && pathname.startsWith(to));

  const NavItem = ({
    to, icon, label, badge,
  }: { to: string; icon: string; label: string; badge?: number }) => (
    <Link
      to={to}
      className={`sb-item${isActive(to) ? " active" : ""}`}
      onClick={() => setMobileOpen(false)}
    >
      <span className="sb-icon">{icon}</span>
      <span className="sb-label">{label}</span>
      {badge ? <span className="sb-badge">{badge > 99 ? "99+" : badge}</span> : null}
    </Link>
  );

  const initials = user?.full_name
    ? user.full_name.split(" ").map((n) => n[0]).join("").substring(0, 2).toUpperCase()
    : "U";

  return (
    <div className="app-shell">
      {/* Mobile overlay */}
      <div
        className={`sb-overlay${mobileOpen ? " open" : ""}`}
        onClick={() => setMobileOpen(false)}
      />

      {/* Sidebar */}
      <aside className={`sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`}>
        <div className="sb-header">
          <Link to="/dashboard" className="sb-logo" aria-label="Dashboard">
            <img src="/logo.png" alt="LumixPay" className="sb-logo-img" />
          </Link>
          <button
            className="sb-toggle"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? "›" : "‹"}
          </button>
        </div>

        <nav className="sb-nav">
          <div className="sb-section-label">MAIN</div>
          <NavItem to="/dashboard"  icon="⊞"  label="Dashboard" />
          <NavItem to="/profile"    icon="👤" label="Profile" />
          <NavItem to="/topup"      icon="💳" label="Top Up" />
          <NavItem to="/transfer"   icon="↗"  label="Transfer" />
          <NavItem to="/withdraw"   icon="↙"  label="Withdraw" />
          <NavItem to="/history"    icon="📋" label="History" />

          <div className="sb-section-label">COMMUNICATION</div>
          <NavItem to="/notifications" icon="🔔" label="Inbox" badge={unreadCount} />
          <NavItem to="/contacts"      icon="👥" label="Contacts" />

          <div className="sb-section-label">PAYMENTS</div>
          <NavItem to="/payment-links" icon="🔗" label="Pay Links" />
          <NavItem to="/vouchers"      icon="🎟" label="Vouchers" />
          <NavItem to="/recurring"     icon="🔁" label="Recurring" />
          <NavItem to="/exchange"      icon="⇌"  label="Exchange" />

          <div className="sb-section-label">DEVELOPERS</div>
          <NavItem to="/developer" icon="🔑" label="Developer" />

          {user?.role === "admin" && (
            <>
              <div className="sb-section-label">ADMIN</div>
              <NavItem to="/admin/withdrawals" icon="📤" label="Withdrawals" />
              <NavItem to="/admin/users"       icon="👤" label="Users" />
              <NavItem to="/admin/ledger"      icon="📊" label="Ledger" />
              <NavItem to="/admin/alerts"      icon="🚨" label="Alerts" />
              <NavItem to="/admin/vouchers"    icon="🎟" label="Vouchers" />
              <NavItem to="/admin/treasury"    icon="🏦" label="Treasury" />
              <NavItem to="/admin/developers"  icon="🔑" label="Developers" />
            </>
          )}
        </nav>

        {/* User / logout */}
        <div className="sb-footer">
          <div className="sb-user-row">
            <div className="sb-avatar">{initials}</div>
            <div className="sb-user-info">
              <div className="sb-user-name">{user?.full_name}</div>
              <div className="sb-user-email">{user?.email}</div>
            </div>
          </div>

          {/* Push notifications toggle */}
          {"Notification" in window && "serviceWorker" in navigator && (
            <button
              className="sb-item"
              disabled={pushLoading}
              onClick={async () => {
                setPushLoading(true);
                try {
                  if (pushOn) {
                    await unsubscribeFromPush(token ?? "");
                    setPushOn(false);
                    setPushStatus("DISABLED");
                    addToast("Push notifications disabled", "info");
                  } else {
                    const ok = await subscribeToPush(token ?? "");
                    if (ok) {
                      setPushOn(true);
                      setPushStatus("ENABLED");
                      addToast("Push notifications enabled", "success");
                    } else {
                      const status = Notification.permission === "denied" ? "BLOCKED" : "PERMISSION_REQUIRED";
                      setPushStatus(status);
                      addToast("Push permission was not granted", "info");
                    }
                  }
                } catch (e: any) {
                  console.error("Push toggle error:", e);
                  addToast(e?.message ?? "Push setup failed", "error");
                } finally {
                  setPushLoading(false);
                }
              }}
              style={{ width: "100%", cursor: "pointer", background: "none", border: "none", textAlign: "left" }}
            >
              <span className="sb-icon">{pushOn ? "🔕" : "🔔"}</span>
              <span className="sb-label">{pushLoading ? "…" : pushOn ? "Disable Push" : "Enable Push"}</span>
            </button>
          )}

          {/* Install App — shown when available or on iOS (not already installed) */}
          {!isInStandaloneMode() && (installAvailable || isIos()) && (
            <button
              className="sb-item"
              onClick={async () => {
                if (isIos()) { setShowIosModal(true); return; }
                const outcome = await promptInstall();
                if (outcome === "accepted") setInstallAvailable(false);
              }}
              style={{ width: "100%", cursor: "pointer", background: "none", border: "none", textAlign: "left" }}
            >
              <span className="sb-icon">📲</span>
              <span className="sb-label">Install App</span>
            </button>
          )}

          <button
            className="sb-item"
            onClick={logout}
            style={{ width: "100%", cursor: "pointer", background: "none", border: "none", textAlign: "left" }}
          >
            <span className="sb-icon">🚪</span>
            <span className="sb-label">Logout</span>
          </button>
        </div>
      </aside>

      {/* iOS install instructions modal */}
      {showIosModal && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 999,
            background: "rgba(0,0,0,.6)", display: "flex",
            alignItems: "flex-end", justifyContent: "center", padding: 16,
          }}
          onClick={() => setShowIosModal(false)}
        >
          <div
            style={{
              background: "var(--surface)", borderRadius: 16, padding: "24px 20px",
              maxWidth: 400, width: "100%", textAlign: "center",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p style={{ fontSize: "1.5rem", marginBottom: 10 }}>📲</p>
            <h3 style={{ marginBottom: 10 }}>Install LumixPay</h3>
            <p className="muted" style={{ marginBottom: 16, lineHeight: 1.6 }}>
              To install on iOS: tap the{" "}
              <strong>Share</strong> button (
              <span style={{ fontSize: "1.1rem" }}>⬆</span>) in Safari, then select{" "}
              <strong>Add to Home Screen</strong>.
            </p>
            <button onClick={() => setShowIosModal(false)}>Got it</button>
          </div>
        </div>
      )}

      {/* Mobile top bar */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <div className="shell-topbar">
          <button className="sb-toggle" onClick={() => setMobileOpen((o) => !o)} style={{ fontSize: "1.2rem" }}>
            ☰
          </button>
          <Link to="/dashboard" style={{ textDecoration: "none", display: "flex", alignItems: "center" }}>
            <img src="/logo.png" alt="LumixPay" style={{ height: 28, objectFit: "contain" }} />
          </Link>
        </div>
        <main className="shell-main">{children}</main>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Require auth guard
// ─────────────────────────────────────────────────────────────────────────────

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token, ready } = useAuth();
  if (!ready) return null;
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

/**
 * Shows the splash overlay until the app has resolved auth state and
 * performed the initial balances fetch (or determined the user is logged out).
 */
function AppBoot({ children }: { children: React.ReactNode }) {
  const { token, ready } = useAuth();
  const { loading: balancesLoading } = useBalances();
  // Show overlay on first paint while token is present and balances haven't loaded yet
  const [booting, setBooting] = React.useState(true);

  React.useEffect(() => {
    // If there's no token we're done immediately; if token exists wait for balances
    if (!ready) { setBooting(true); return; }
    if (!token) { setBooting(false); return; }
    if (!balancesLoading) { setBooting(false); }
  }, [token, balancesLoading, ready]);

  return (
    <>
      <LoadingOverlay visible={booting} />
      {children}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────

// Helper: wrap a page in RequireAuth + AppShell
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BalancesProvider>
          <NotificationsProvider>
            <AppBoot>
            <Routes>
              {/* ── Public auth pages ── */}
              <Route path="/login"    element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />

              {/* ── Authenticated pages (sidebar layout) ── */}
              <Route path="/dashboard"  element={<Shell><DashboardPage /></Shell>} />
              <Route path="/topup"      element={<Shell><TopUpPage /></Shell>} />
              <Route path="/transfer"   element={<Shell><TransferPage /></Shell>} />
              <Route path="/withdraw"   element={<Shell><WithdrawPage /></Shell>} />
              <Route path="/history"    element={<Shell><HistoryPage /></Shell>} />
              <Route path="/notifications" element={<Shell><NotificationsPage /></Shell>} />

              {/* ── Phase 4 ── */}
              <Route path="/profile"  element={<Shell><ProfilePage /></Shell>} />
              <Route path="/contacts" element={<Shell><ContactsPage /></Shell>} />

              {/* ── Phase 5 ── */}
              <Route path="/payment-links" element={<Shell><PaymentLinksPage /></Shell>} />
              <Route path="/pay/:id"       element={<PayPage />} />

              {/* ── Phase 6 ── */}
              <Route path="/vouchers"       element={<Shell><VouchersPage /></Shell>} />
              <Route path="/admin/vouchers" element={<Shell><AdminVouchersPage /></Shell>} />

              {/* ── Phase 7 ── */}
              <Route path="/recurring" element={<Shell><RecurringPage /></Shell>} />

              {/* ── Phase 8 ── */}
              <Route path="/developer" element={<Shell><DeveloperPage /></Shell>} />

              {/* ── Phase 9 ── */}
              <Route path="/admin/withdrawals" element={<Shell><AdminWithdrawalsPage /></Shell>} />
              <Route path="/admin/users"       element={<Shell><AdminUsersPage /></Shell>} />
              <Route path="/admin/ledger"      element={<Shell><AdminLedgerPage /></Shell>} />
              <Route path="/admin/alerts"      element={<Shell><AdminAlertsPage /></Shell>} />

              {/* ── New pages ── */}
              <Route path="/exchange"       element={<Shell><ExchangePage /></Shell>} />
              <Route path="/admin/treasury"    element={<Shell><AdminTreasuryPage /></Shell>} />
              <Route path="/admin/developers"  element={<Shell><AdminDevelopersPage /></Shell>} />

              {/* ── Public marketing pages ── */}
              <Route path="/"             element={<LandingPage />} />
              <Route path="/pricing"      element={<PricingPage />} />
              <Route path="/developers"   element={<DevelopersPage />} />
              <Route path="/docs"         element={<DocsPage />} />
              <Route path="/demo"         element={<DemoPage />} />
              <Route path="/architecture" element={<ArchitecturePage />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </AppBoot>
          </NotificationsProvider>
        </BalancesProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
