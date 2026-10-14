"use client";

import { useEffect, useState } from "react";

/**
 * Marks the document as scripted (so entrance styles apply) and reveals each
 * [data-reveal] block once as it enters the viewport. Without script, or with
 * reduced motion, everything is simply visible.
 *
 * Also closes the small-screen menu (a <details>) on a tap outside it, on
 * Escape and after a link in it is chosen. The menu opens and works without
 * script; this only adds the expected ways to close it (DESIGN.md 23).
 */
export function Motion() {
  useEffect(() => {
    const root = document.documentElement;
    const blocks = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    let io: IntersectionObserver | null = null;
    if (!("IntersectionObserver" in window)) {
      blocks.forEach((b) => b.classList.add("in"));
    } else {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add("in");
              io?.unobserve(e.target);
            }
          }
        },
        { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
      );
      blocks.forEach((b) => io?.observe(b));
      root.classList.add("js-ready");
    }

    const openMenus = () => Array.from(document.querySelectorAll<HTMLDetailsElement>("details.menu[open]"));
    const onPointer = (e: PointerEvent) => {
      for (const m of openMenus()) {
        const panel = m.querySelector(".menu-panel");
        const summary = m.querySelector("summary");
        const t = e.target as Node;
        if (!panel?.contains(t) && !summary?.contains(t)) m.open = false;
      }
    };
    // A chosen link closes the menu after the click has navigated or scrolled.
    const onClick = (e: MouseEvent) => {
      const link = e.target instanceof Element ? e.target.closest(".menu-panel a") : null;
      const menu = link?.closest<HTMLDetailsElement>("details.menu");
      if (menu) menu.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const m of openMenus()) {
        m.open = false;
        m.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      io?.disconnect();
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return null;
}

export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      <span aria-live="polite">{copied ? done : label}</span>
    </button>
  );
}
