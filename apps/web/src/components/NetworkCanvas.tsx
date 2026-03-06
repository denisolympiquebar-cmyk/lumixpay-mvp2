import React, { useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Tunable constants
// ─────────────────────────────────────────────────────────────────────────────

const NODE_COUNT      = 55;
const CONNECTION_DIST = 160;   // px — max distance for drawing a line
const NODE_RADIUS     = 2.2;   // base radius
const SPEED           = 0.35;  // drift speed multiplier
const PARALLAX_STRENGTH = 18;  // max px of mouse parallax movement

const NODE_COLOR  = "#ff7a18";
const GLOW_COLOR  = "rgba(255,122,24,.22)";
const LINE_COLOR  = "rgba(255,122,24,";

// ─────────────────────────────────────────────────────────────────────────────

interface Node {
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  opacity: number;
}

function makeNode(w: number, h: number): Node {
  const angle  = Math.random() * Math.PI * 2;
  const speed  = (0.2 + Math.random() * 0.5) * SPEED;
  return {
    x:  Math.random() * w,
    y:  Math.random() * h,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    r:  NODE_RADIUS * (0.7 + Math.random() * 0.8),
    opacity: 0.55 + Math.random() * 0.45,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export function NetworkCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse     = useRef({ x: 0, y: 0 });

  useEffect(() => {
    // Respect prefers-reduced-motion
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let nodes: Node[] = [];
    let w = 0, h = 0;

    const resize = () => {
      const parent = canvas.parentElement!;
      w = canvas.width  = parent.offsetWidth;
      h = canvas.height = parent.offsetHeight;
      nodes = Array.from({ length: NODE_COUNT }, () => makeNode(w, h));
    };

    const onMouse = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.current.x = e.clientX - rect.left;
      mouse.current.y = e.clientY - rect.top;
    };
    const onTouch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const rect = canvas.getBoundingClientRect();
      mouse.current.x = t.clientX - rect.left;
      mouse.current.y = t.clientY - rect.top;
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);

      // Parallax offset based on mouse position (relative to canvas centre)
      const pxOff = ((mouse.current.x / w) - 0.5) * PARALLAX_STRENGTH;
      const pyOff = ((mouse.current.y / h) - 0.5) * PARALLAX_STRENGTH;

      // Update + wrap nodes
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -50)  n.x = w + 50;
        if (n.x > w + 50) n.x = -50;
        if (n.y < -50)  n.y = h + 50;
        if (n.y > h + 50) n.y = -50;
      }

      // Draw connections
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const ni = nodes[i]!, nj = nodes[j]!;
          const dx = (ni.x + pxOff) - (nj.x + pxOff);
          const dy = (ni.y + pyOff) - (nj.y + pyOff);
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > CONNECTION_DIST) continue;
          const alpha = (1 - dist / CONNECTION_DIST) * 0.3 * Math.min(ni.opacity, nj.opacity);
          ctx.beginPath();
          ctx.strokeStyle = `${LINE_COLOR}${alpha.toFixed(3)})`;
          ctx.lineWidth   = 0.8;
          ctx.moveTo(ni.x + pxOff, ni.y + pyOff);
          ctx.lineTo(nj.x + pxOff, nj.y + pyOff);
          ctx.stroke();
        }
      }

      // Draw nodes
      for (const n of nodes) {
        const nx = n.x + pxOff;
        const ny = n.y + pyOff;

        // Glow
        const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, n.r * 6);
        grad.addColorStop(0, GLOW_COLOR);
        grad.addColorStop(1, "rgba(255,122,24,0)");
        ctx.beginPath();
        ctx.arc(nx, ny, n.r * 6, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // Core dot
        ctx.beginPath();
        ctx.arc(nx, ny, n.r, 0, Math.PI * 2);
        ctx.fillStyle = NODE_COLOR;
        ctx.globalAlpha = n.opacity;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(draw);
    };

    // Pause when tab hidden to save power
    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else raf = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouse);
    window.addEventListener("touchmove", onTouch, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouse);
      window.removeEventListener("touchmove", onTouch);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  );
}
