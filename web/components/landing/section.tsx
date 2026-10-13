import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The landing page's one layout primitive: a full-width band separated by a
 * hairline, holding a railed content column. Every section uses it, so the
 * vertical rhythm (padding, rails, max width) lives in exactly one place.
 */
export function Band({
  id,
  className,
  innerClassName,
  children,
  labelledBy,
}: {
  id?: string;
  className?: string;
  innerClassName?: string;
  children: React.ReactNode;
  labelledBy?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn("scroll-mt-16 border-b border-border", className)}
    >
      <div className={cn("frame-rails mx-auto max-w-[1120px] px-4 py-20 sm:px-8 sm:py-28", innerClassName)}>
        {children}
      </div>
    </section>
  );
}

/** Small accent label that introduces a section heading. */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[13px] font-semibold tracking-[0.01em] text-fern", className)}>{children}</p>
  );
}

/** Display heading used by every landing section (h2). */
export function SectionHeading({
  id,
  children,
  className,
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      id={id}
      className={cn(
        "mt-3 text-balance text-[clamp(1.75rem,4.2vw,2.5rem)] font-medium leading-[1.15] tracking-[-0.02em] text-ink",
        className
      )}
    >
      {children}
    </h2>
  );
}

/** "Bold lead, muted continuation" — the two-tone caption used under tiles and rows. */
export function LeadIn({ lead, children, className }: { lead: string; children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[15px] leading-relaxed text-muted-foreground", className)}>
      <strong className="font-semibold text-ink">{lead}</strong> {children}
    </p>
  );
}
