import React, { createContext, useContext, useState, useCallback } from "react";

export interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

interface ToastCtx {
  addToast: (message: string, type?: Toast["type"]) => void;
}

const ToastContext = createContext<ToastCtx>({ addToast: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast["type"] = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div
        style={{
          position: "fixed",
          bottom: 28,
          right: 24,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background:
                t.type === "success"
                  ? "#16a34a"
                  : t.type === "error"
                  ? "#dc2626"
                  : "#1e293b",
              color: "#fff",
              padding: "12px 18px",
              borderRadius: 10,
              fontSize: "0.88rem",
              fontWeight: 500,
              boxShadow: "0 4px 24px rgba(0,0,0,0.35)",
              maxWidth: 320,
              borderLeft: `4px solid ${
                t.type === "success" ? "#4ade80" : t.type === "error" ? "#f87171" : "#7c3aed"
              }`,
              animation: "lpSlideIn 0.25s ease",
              pointerEvents: "auto",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
