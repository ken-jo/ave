"use client";

/* Kept apart from client.tsx so pages without this action do not load the
   Button's class utilities (DESIGN.md 31). */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";

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
