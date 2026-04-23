import React from "react";
import "./SlideToAction.css";

const KNOB_SIZE = 48;
const TRACK_PAD = 4; // padding on each side (top and left offset of knob)

interface SlideToActionProps {
  /** Text shown centered in the track, e.g. "slide to confirm transfer" */
  label: string;
  /** Called once after the completion animation (≈300 ms after threshold reached) */
  onComplete: () => void;
  /** Fraction of travel required to trigger (0–1). Default: 0.80 */
  threshold?: number;
  /** Prevents interaction and greys out the slider */
  disabled?: boolean;
  /** Optional class on the outer track */
  className?: string;
}

export function SlideToAction({
  label,
  onComplete,
  threshold = 0.80,
  disabled = false,
  className,
}: SlideToActionProps) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const dragRef  = React.useRef<{ pointerId: number; startX: number } | null>(null);

  const [progress,   setProgress]   = React.useState(0);     // 0–1 during drag
  const [isDragging, setIsDragging] = React.useState(false);
  const [isDone,     setIsDone]     = React.useState(false);
  const [isSnapping, setIsSnapping] = React.useState(false); // spring-back or snap-complete

  const maxTravel = React.useCallback(() => {
    const w = trackRef.current?.offsetWidth ?? 0;
    return Math.max(0, w - KNOB_SIZE - TRACK_PAD * 2);
  }, []);

  const knobX  = progress * maxTravel();
  const fillW  = knobX + KNOB_SIZE + TRACK_PAD; // left pad + knob right edge

  // ── pointer handlers ────────────────────────────────────────────────────────
  const onPointerDown = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || isDone) return;
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX };
    setIsDragging(true);
    setIsSnapping(false);
  }, [disabled, isDone]);

  const onPointerMove = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;

    const travel = maxTravel();
    const dx     = e.clientX - d.startX;
    const next   = Math.max(0, Math.min(1, dx / travel));
    setProgress(next);

    if (next >= threshold) {
      dragRef.current = null;
      setIsDragging(false);
      setIsSnapping(false);
      setIsDone(true);
      setProgress(1);
      setTimeout(onComplete, 300);
    }
  }, [maxTravel, threshold, onComplete]);

  const onPointerUp = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (!isDone) {
      setIsSnapping(true);
      setProgress(0);
      setTimeout(() => setIsSnapping(false), 380);
    }
  }, [isDone]);

  // Keyboard fallback: Enter / Space triggers completion
  const onKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || isDone) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setIsDone(true);
      setProgress(1);
      setTimeout(onComplete, 300);
    }
  }, [disabled, isDone, onComplete]);

  const trackCls = [
    "sta-track",
    isDone      ? "sta-complete"  : "",
    disabled    ? "sta-disabled"  : "",
    className   ?? "",
  ].filter(Boolean).join(" ");

  const fillCls  = ["sta-fill",  isSnapping || isDone ? "sta-fill-snap" : ""].filter(Boolean).join(" ");
  const knobCls  = ["sta-knob",  isDragging           ? "sta-knob-active" : ""].filter(Boolean).join(" ");

  return (
    <div
      ref={trackRef}
      className={trackCls}
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKeyDown}
    >
      {/* sliding fill */}
      <div className={fillCls} style={{ width: fillW }} aria-hidden="true" />

      {/* centered label */}
      <span className="sta-label" aria-hidden="true">
        {isDone ? "✓" : label}
      </span>

      {/* draggable knob — pointer events routed here so capture works cleanly */}
      <div
        className={knobCls}
        style={{ transform: `translateX(${knobX}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-hidden="true"
      >
        {isDone ? "✓" : "›"}
      </div>
    </div>
  );
}
