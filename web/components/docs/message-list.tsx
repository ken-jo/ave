import * as React from "react";
import { cn } from "@/lib/utils";

export interface MessageItem {
  /** The app's sentence, quoted as the app shows it. */
  message: React.ReactNode;
  /** What to do, or what the message means, beyond what it says itself. */
  fix?: React.ReactNode;
  /** Where the message appears or what it is about (a short label). */
  label?: string;
  tone?: "policy" | "warning" | "error";
}

const toneClass: Record<NonNullable<MessageItem["tone"]>, string> = {
  policy: "border-l-ink/40",
  warning: "border-l-amber-400",
  error: "border-l-red-400",
};

/**
 * App messages quoted word for word, each with what to do. The left rule
 * carries the message's tone as the app shows it (policy, warning, error).
 */
export function MessageList({ items, className }: { items: MessageItem[]; className?: string }) {
  return (
    <ul className={cn("my-5 grid list-none gap-3 !pl-0", className)}>
      {items.map((item, idx) => (
        <li
          key={idx}
          className={cn(
            "min-w-0 rounded-lg border border-border border-l-4 bg-white p-3.5 [overflow-wrap:anywhere]",
            toneClass[item.tone ?? "error"]
          )}
        >
          {item.label ? (
            <p className="!my-0 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{item.label}</p>
          ) : null}
          <p className="!my-1 text-[14px] leading-relaxed text-ink">“{item.message}”</p>
          {item.fix ? <div className="text-[13.5px] leading-relaxed text-muted-foreground [&_p]:my-1">{item.fix}</div> : null}
        </li>
      ))}
    </ul>
  );
}
