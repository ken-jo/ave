/**
 * How the user's own terminals behave: scrollback, cursor, the Option key, copy on select and the shell. Drawn inside the
 * terminal's settings section, under its font. Every field saves on its own; open terminals take a change at once, except
 * the shell, which the next terminal starts.
 */
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_TERMINAL_BEHAVIOR, TERMINAL_CURSOR_STYLES, TERMINAL_SCROLLBACK_STEP, isTerminalScrollback, isTerminalShellPath,
  type TerminalBehaviorSettings, type TerminalCursorStyle,
} from "../../../shared/appearance-settings.js";
import { getApi, isDarwin } from "../api-client.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { useTheme } from "../theme/index.js";
import { useTranslation } from "../../../i18n/react.js";

const CURSOR_LABELS: Record<TerminalCursorStyle, string> = {
  block: "appearanceTab.terminalCursorBlock",
  bar: "appearanceTab.terminalCursorBar",
  underline: "appearanceTab.terminalCursorUnderline",
};

export function TerminalBehaviorFields() {
  const { t, locale } = useTranslation();
  const notifySaved = useNotifySaved();
  const { appearance } = useTheme();
  const saved = appearance.terminal;
  const [shown, setShown] = useState<TerminalBehaviorSettings>(saved);
  const [failed, setFailed] = useState(false);
  const [shellDraft, setShellDraft] = useState(saved.shell);
  const revision = useRef(0);
  useEffect(() => {
    revision.current++;
    setShown(saved);
    setShellDraft(saved.shell);
  }, [saved]);

  const update = (patch: Partial<TerminalBehaviorSettings>): void => {
    const mine = ++revision.current;
    setShown((current) => ({ ...current, ...patch }));
    setFailed(false);
    void getApi().updateSettings({ appearance: { terminal: patch } }).then(notifySaved, () => {
      if (mine !== revision.current) return;
      setFailed(true);
      setShown(saved);
      setShellDraft(saved.shell);
    });
  };
  const shellValid = isTerminalShellPath(shellDraft.trim());
  const commitShell = (): void => {
    const shell = shellDraft.trim();
    if (!isTerminalShellPath(shell) || shell === shown.shell) return;
    update({ shell });
  };
  const fewer = shown.scrollback - TERMINAL_SCROLLBACK_STEP;
  const more = shown.scrollback + TERMINAL_SCROLLBACK_STEP;

  return (
    <div className="space-y-4 border-t border-border pt-4" data-testid="terminal-behavior-fields">
      {failed && <p role="alert" className="text-sm text-destructive" data-testid="terminal-behavior-save-failed">{t("appearanceTab.terminalBehaviorSaveFailed")}</p>}
      <div className="flex flex-wrap gap-6">
        <fieldset aria-label={t("appearanceTab.terminalScrollback")} className="space-y-1">
          <legend className="text-dense text-muted-foreground">{t("appearanceTab.terminalScrollback")}</legend>
          <div className="flex items-center gap-2 text-sm">
            <button type="button" aria-label={`${t("appearanceTab.terminalScrollback")} −`} disabled={!isTerminalScrollback(fewer)} onClick={() => update({ scrollback: fewer })}
              className="rounded border border-input px-2 py-1 disabled:opacity-(--opacity-half)">−</button>
            <span className="min-w-24 text-center tabular-nums" data-testid="terminal-scrollback-value">{t("appearanceTab.terminalScrollbackLines", { lines: new Intl.NumberFormat(locale).format(shown.scrollback) })}</span>
            <button type="button" aria-label={`${t("appearanceTab.terminalScrollback")} +`} disabled={!isTerminalScrollback(more)} onClick={() => update({ scrollback: more })}
              className="rounded border border-input px-2 py-1 disabled:opacity-(--opacity-half)">+</button>
          </div>
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="text-dense text-muted-foreground">{t("appearanceTab.terminalCursor")}</legend>
          <div className="flex flex-wrap gap-2" data-testid="terminal-cursor-styles">
            {TERMINAL_CURSOR_STYLES.map((style) => (
              <label key={style} className={shown.cursorStyle === style
                ? "cursor-pointer rounded-full border border-primary bg-primary px-3 py-1 text-xs text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
                : "cursor-pointer rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"}>
                <input type="radio" name="terminal-cursor-style" className="sr-only" value={style} checked={shown.cursorStyle === style} onChange={() => update({ cursorStyle: style })} />
                {t(CURSOR_LABELS[style])}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={shown.copyOnSelect} data-testid="terminal-copy-on-select" onChange={(event) => update({ copyOnSelect: event.target.checked })} />
          <span>{t("appearanceTab.terminalCopyOnSelect")}</span>
        </label>
        {isDarwin() ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={shown.optionAsMeta} data-testid="terminal-option-as-meta" onChange={(event) => update({ optionAsMeta: event.target.checked })} />
            <span>{t("appearanceTab.terminalOptionAsMeta")}<span className="block text-dense text-muted-foreground">{t("appearanceTab.terminalOptionAsMetaHint")}</span></span>
          </label>
        ) : null}
      </div>
      <div className="space-y-1">
        <label htmlFor="terminal-shell-path" className="text-dense text-muted-foreground">{t("appearanceTab.terminalShell")}</label>
        <input id="terminal-shell-path" type="text" spellCheck={false} autoComplete="off" value={shellDraft} data-testid="terminal-shell-path"
          placeholder={t("appearanceTab.terminalShellPlaceholder")} aria-invalid={!shellValid} aria-describedby="terminal-shell-hint"
          className="h-8 w-full max-w-md rounded border border-input bg-background px-2 font-mono text-xs aria-invalid:border-destructive"
          onChange={(event) => setShellDraft(event.target.value)} onBlur={commitShell}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commitShell(); } }} />
        <p id="terminal-shell-hint" className={shellValid ? "text-dense text-muted-foreground" : "text-dense text-destructive"} data-testid="terminal-shell-hint">
          {shellValid ? t("appearanceTab.terminalShellHint") : t("appearanceTab.terminalShellInvalid")}
        </p>
        {shown.shell !== DEFAULT_TERMINAL_BEHAVIOR.shell ? (
          <button type="button" className="rounded border border-input px-2 py-1 text-xs hover:bg-muted" data-testid="terminal-shell-reset"
            onClick={() => { setShellDraft(""); update({ shell: "" }); }}>{t("appearanceTab.terminalShellReset")}</button>
        ) : null}
      </div>
    </div>
  );
}
