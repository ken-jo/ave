"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";

/**
 * Marks the document as scripted (so entrance styles apply) and reveals each
 * [data-reveal] block once as it enters the viewport. Without script, or with
 * reduced motion, everything is simply visible.
 */
export function Motion() {
  useEffect(() => {
    const root = document.documentElement;
    const blocks = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (!("IntersectionObserver" in window)) {
      blocks.forEach((b) => b.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    );
    blocks.forEach((b) => io.observe(b));
    root.classList.add("js-ready");
    return () => io.disconnect();
  }, []);
  return null;
}

type OsKey = "mac" | "windows" | "linux";

function detectOs(): OsKey | null {
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua) && !/iPhone|iPad/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua) && !/Android/.test(ua)) return "linux";
  return null;
}

/** The hero's one action: names the visitor's system when it can tell. */
export function OsCta({ base, labels }: { base: string; labels: { any: string; mac: string; windows: string; linux: string } }) {
  const [os, setOs] = useState<OsKey | null>(null);
  useEffect(() => setOs(detectOs()), []);
  const label = os ? labels[os] : labels.any;
  return (
    <Button asChild className="group">
      <Link href={os ? `${base}#${os}` : base}>
        {label}
        <span className="motion-safe:transition-transform motion-safe:duration-150 motion-safe:group-hover:translate-x-0.5" aria-hidden="true">→</span>
      </Link>
    </Button>
  );
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
