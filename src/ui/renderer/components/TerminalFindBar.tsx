/**
 * Find in a terminal's screen and scrollback: a small bar over the top right of the output, opened by the app's search key
 * while the terminal has the keyboard. Enter goes to the next match and Shift+Enter to the previous one; Escape closes the
 * bar, clears the marks and gives the keyboard back to the shell.
 */
import { useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import type { LiveTerminal, TerminalFindResult } from "./live-terminal.js";

const BUTTON_CLASS = "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent";

export function TerminalFindBar({ live, onClose }: { live: LiveTerminal; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<TerminalFindResult | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return live.onFindResult(setResult);
  }, [live]);
  // The marks belong to the open bar: they go when it closes, however it closes.
  useEffect(() => () => live.clearFind(), [live]);

  const search = (text: string, direction: "next" | "previous", sensitive: boolean, incremental: boolean): void => {
    if (text.length === 0) {
      live.clearFind();
      setResult(null);
      return;
    }
    // A query with no match reports no result event of its own.
    if (!live.find(text, direction, { caseSensitive: sensitive, incremental })) setResult({ index: 0, count: 0 });
  };
  const close = (): void => {
    onClose();
    live.focus();
  };
  const none = query.length > 0 && result !== null && result.count === 0;
  const status = query.length === 0 || result === null ? ""
    : result.count === 0 ? t("ptyTerminal.findNoResults")
    : t("ptyTerminal.findCount", { index: result.index, count: result.count });

  return (
    <search aria-label={t("ptyTerminal.findLabel")} data-testid="terminal-find-bar"
      className="absolute right-3 top-1 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded border border-border bg-popover px-1.5 py-1 text-xs text-popover-foreground shadow-md"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <input ref={inputRef} type="text" value={query} spellCheck={false} autoComplete="off" data-testid="terminal-find-input"
        aria-label={t("ptyTerminal.findLabel")} placeholder={t("ptyTerminal.findPlaceholder")} aria-invalid={none}
        className="h-6 w-40 min-w-0 rounded border border-input bg-background px-1.5 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring aria-invalid:border-destructive"
        onChange={(event) => { setQuery(event.target.value); search(event.target.value, "next", caseSensitive, true); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          search(query, event.shiftKey ? "previous" : "next", caseSensitive, false);
        }} />
      <span className="min-w-12 shrink-0 text-center tabular-nums text-muted-foreground" aria-live="polite" data-testid="terminal-find-status">{status}</span>
      <button type="button" className={`${BUTTON_CLASS} ${caseSensitive ? "bg-primary/(--opacity-subtle) text-primary" : ""}`} aria-pressed={caseSensitive}
        title={t("ptyTerminal.findCaseSensitive")} aria-label={t("ptyTerminal.findCaseSensitive")} data-testid="terminal-find-case"
        onClick={() => { const next = !caseSensitive; setCaseSensitive(next); search(query, "next", next, true); }}>
        <CaseSensitive className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" className={BUTTON_CLASS} disabled={query.length === 0} title={t("ptyTerminal.findPrevious")} aria-label={t("ptyTerminal.findPrevious")}
        data-testid="terminal-find-previous" onClick={() => search(query, "previous", caseSensitive, false)}>
        <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" className={BUTTON_CLASS} disabled={query.length === 0} title={t("ptyTerminal.findNext")} aria-label={t("ptyTerminal.findNext")}
        data-testid="terminal-find-next" onClick={() => search(query, "next", caseSensitive, false)}>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" className={BUTTON_CLASS} title={t("ptyTerminal.findClose")} aria-label={t("ptyTerminal.findClose")} data-testid="terminal-find-close" onClick={close}>
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </search>
  );
}
