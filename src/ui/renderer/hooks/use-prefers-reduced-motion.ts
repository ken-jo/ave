/** Subscribe to reduced-motion changes so the running UI follows OS toggles without remounting. */
import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

/** Current preference; `false` where `matchMedia` is absent (non-DOM tests). */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(() => reducedMotionQuery()?.matches ?? false);
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const onChange = () => setReduce(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduce;
}
