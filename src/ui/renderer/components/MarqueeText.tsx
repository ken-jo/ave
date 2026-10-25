import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion.js";

/** Use static truncation before measurement or under reduced motion; otherwise scroll at constant pixels per second and
 * pause on hover/focus. */
export function MarqueeText({
  text,
  className,
  "data-testid": testId,
}: {
  text: string;
  className?: string;
  "data-testid"?: string;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (reducedMotion) {
      setOverflowing(false);
      return;
    }
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const measure = () => {
      const contentWidth = content.scrollWidth;
      const viewportWidth = viewport.clientWidth;
      const overflow = contentWidth - viewportWidth;
      if (overflow > 1) {
        setOverflowing(true);
        // ~40px/sec while moving. The keyframe reserves 16% of the cycle for edge pauses, so include that idle time instead of
        // shortening travel.
        const PX_PER_SEC = 40;
        const MOVING_KEYFRAME_RATIO = 0.84;
        const travel = contentWidth + 24; // content + gap between the two copies
        setDurationSec(Math.max(8, travel / PX_PER_SEC / MOVING_KEYFRAME_RATIO));
      } else {
        setOverflowing(false);
      }
    };

    measure();
    const ResizeObserverCtor = window.ResizeObserver;
    if (typeof ResizeObserverCtor !== "function") return;
    const observer = new ResizeObserverCtor(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text, reducedMotion]);

  const measurer = (
    <span ref={contentRef} className="invisible absolute whitespace-nowrap" aria-hidden>
      {text}
    </span>
  );

  const rootClassName = overflowing
    ? `relative ave-marquee-viewport ave-marquee-fade block min-w-0 ${className ?? ""}`
    : `relative block min-w-0 truncate ${className ?? ""}`;

  return (
    <span
      ref={viewportRef}
      className={rootClassName}
      title={text}
      data-testid={testId}
      data-marquee={overflowing ? "animate" : "static"}
      tabIndex={overflowing ? 0 : undefined}
    >
      {measurer}
      {overflowing ? (
        // Overflowing — scroll a duplicated track. aria-hidden on the second copy so screen readers announce the text once.
        <span
          className="ave-marquee-track"
          style={{ ["--ave-marquee-duration" as string]: `${durationSec}s` }}
        >
          <span className="pr-6">
            {text}
          </span>
          <span className="pr-6" aria-hidden>
            {text}
          </span>
        </span>
      ) : (
        text
      )}
    </span>
  );
}
