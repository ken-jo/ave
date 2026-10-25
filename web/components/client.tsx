"use client";

import { useEffect, useState } from "react";

/**
 * Small page behaviours that need script; the pages work without it.
 * - The small-screen menu (a <details>) closes on a tap outside it, on
 *   Escape, and after one of its links is chosen.
 * - The language switch keeps the part of the page you are reading: it
 *   carries the current #hash over to the other language's page.
 */
export function SiteScripts() {
  useEffect(() => {
    const openMenus = () => Array.from(document.querySelectorAll<HTMLDetailsElement>("details.menu[open]"));
    const onPointer = (e: PointerEvent) => {
      for (const m of openMenus()) {
        if (!m.contains(e.target as Node)) m.open = false;
      }
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const menuLink = target?.closest(".menu-panel a");
      const menu = menuLink?.closest<HTMLDetailsElement>("details.menu");
      if (menu) menu.open = false;
      const lang = target?.closest<HTMLAnchorElement>("a[hreflang]");
      if (lang && location.hash) {
        const url = new URL(lang.href);
        url.hash = location.hash;
        lang.href = url.toString();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const m of openMenus()) {
        m.open = false;
        m.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("click", onClick, true);
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
          // Clipboard access can be refused (insecure context, permissions); the command stays selectable.
          setCopied(false);
        }
      }}
    >
      <span aria-live="polite">{copied ? done : label}</span>
    </button>
  );
}
