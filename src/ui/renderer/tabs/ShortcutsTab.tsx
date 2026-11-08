import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, RotateCcw } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { cn } from "../../../lib/utils.js";
import {
  acceleratorFromEvent,
  acceleratorKeycaps,
  conflictingShortcutIds,
  defaultAccelerator,
  formatAccelerator,
  resolveShortcuts,
  SHORTCUT_SCOPE_LABEL_KEYS,
  SHORTCUT_SCOPES,
  shortcutBindingRefusal,
  shortcutDefinition,
  type ResolvedShortcut,
  type ShortcutBindingRefusal,
  type ShortcutId,
} from "../../../shared/shortcuts.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { getApi } from "../api-client.js";
import { formatIpcError } from "../format-ipc-error.js";
import { rendererShortcutPlatform, setShortcutCaptureActive, useShortcutSettings } from "../hooks/use-shortcuts.js";
import { isIpcErrorResult } from "../types.js";

type ShortcutFilter = "all" | "modified" | "conflicts";
const FILTERS: readonly ShortcutFilter[] = ["all", "modified", "conflicts"];

/** Why the key just pressed was not taken, shown beside the row that is recording. */
type CaptureNotice = { kind: "unsupported" } | { kind: "refused"; refusal: ShortcutBindingRefusal } | { kind: "failed"; message: string };

function Keycaps({ accelerator, platform }: { accelerator: string; platform: "darwin" | "other" }) {
  return (
    <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
      {acceleratorKeycaps(accelerator, platform).map((cap, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: keycaps are positional and may repeat
        <kbd key={index} className="rounded border border-border bg-muted/(--opacity-muted) px-1.5 py-0.5 font-mono text-tiny text-muted-foreground">
          {cap}
        </kbd>
      ))}
    </span>
  );
}

/** Settings › Keyboard shortcuts: every registry row grouped by where it fires, with search, a conflicts filter,
 * recording a new key, and a per-row reset. Fixed rows are listed with the reason they cannot change. */
export function ShortcutsTab() {
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const settings = useShortcutSettings();
  const platform = rendererShortcutPlatform();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ShortcutFilter>("all");
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [notice, setNotice] = useState<{ id: ShortcutId; notice: CaptureNotice } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => resolveShortcuts(settings, platform), [settings, platform]);
  const conflicts = useMemo(() => conflictingShortcutIds(rows, platform), [rows, platform]);
  const counts: Record<ShortcutFilter, number> = {
    all: rows.length,
    modified: rows.filter((row) => row.modified).length,
    conflicts: conflicts.size,
  };

  const keyText = useCallback((row: ResolvedShortcut) => (row.accelerator === null ? "" : formatAccelerator(row.accelerator, platform)), [platform]);
  const term = query.trim().toLocaleLowerCase();
  const shown = rows.filter((row) => {
    if (filter === "modified" && !row.modified) return false;
    if (filter === "conflicts" && !conflicts.has(row.id)) return false;
    if (!term) return true;
    return [t(row.definition.labelKey), t(SHORTCUT_SCOPE_LABEL_KEYS[row.definition.scope]), keyText(row)]
      .some((text) => text.toLocaleLowerCase().includes(term));
  });
  const groups = SHORTCUT_SCOPES
    .map((scope) => ({ scope, rows: shown.filter((row) => row.definition.scope === scope) }))
    .filter((group) => group.rows.length > 0);

  const persist = useCallback(async (id: ShortcutId, accelerator: string) => {
    const result = await getApi().updateSettings({ shortcuts: { bindings: { [id]: accelerator } } });
    if (isIpcErrorResult(result)) {
      setNotice({ id, notice: { kind: "failed", message: formatIpcError(result.error, result.message) } });
      return;
    }
    setNotice(null);
    notifySaved();
  }, [notifySaved]);

  // While recording, the next chord is the new binding: a capture-phase listener takes it before anything else, and the
  // shortcut matcher goes quiet so app commands registered earlier on the same phase do not run either.
  useEffect(() => {
    if (recordingId === null) return;
    setShortcutCaptureActive(true);
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        setRecordingId(null);
        setNotice(null);
        return;
      }
      const recorded = acceleratorFromEvent(event, platform);
      if (recorded.kind === "pending") return;
      if (recorded.kind === "unsupported") {
        setNotice({ id: recordingId, notice: { kind: "unsupported" } });
        return;
      }
      const refusal = shortcutBindingRefusal(recordingId, recorded.accelerator, platform, settings);
      if (refusal !== null) {
        setNotice({ id: recordingId, notice: { kind: "refused", refusal } });
        return;
      }
      setRecordingId(null);
      void persist(recordingId, recorded.accelerator);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      setShortcutCaptureActive(false);
    };
  }, [recordingId, platform, settings, persist]);

  const reset = useCallback((id: ShortcutId) => {
    const accelerator = defaultAccelerator(id, platform);
    if (accelerator === null) throw new Error(`Shortcut ${id} has no default on this platform`);
    // Writing the default stores no override, which is the reset.
    void persist(id, accelerator);
  }, [platform, persist]);

  const noticeText = (value: CaptureNotice): string => {
    if (value.kind === "failed") return value.message;
    if (value.kind === "unsupported") return t("shortcutsTab.notice.unsupported");
    switch (value.refusal.reason) {
      case "needs-modifier": return t("shortcutsTab.notice.needsModifier");
      case "os-reserved": return t("shortcutsTab.notice.osReserved");
      case "fixed-key": return t("shortcutsTab.notice.fixedKey", { label: t(shortcutDefinition(value.refusal.ownerId).labelKey) });
      default: return t("shortcutsTab.notice.unsupported");
    }
  };

  // Arrow keys move between rows, Home/End jump to the ends; Tab still walks the controls in order.
  useEffect(() => {
    const list = listRef.current;
    if (!list || recordingId !== null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const stops = Array.from(list.querySelectorAll<HTMLElement>("[data-shortcut-nav]"));
      if (stops.length === 0) return;
      const index = stops.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? stops.length - 1
          : index === -1 ? 0
            : Math.min(stops.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
      event.preventDefault();
      stops[next]?.focus();
    };
    list.addEventListener("keydown", onKeyDown);
    return () => list.removeEventListener("keydown", onKeyDown);
  }, [recordingId]);

  return (
    <div className="min-w-0 space-y-6">
      <SettingsPageHeader title={t("shortcutsTab.title")} description={t("shortcutsTab.description")} />
      <SettingsSection data-settings-section="shortcuts-list" title={t("shortcutsTab.listTitle")} description={t("shortcutsTab.listDescription")}>
        <div className="space-y-3">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("shortcutsTab.searchPlaceholder")}
            aria-label={t("shortcutsTab.searchPlaceholder")}
            data-testid="shortcuts:search"
          />
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
            <legend className="sr-only">{t("shortcutsTab.filterLabel")}</legend>
            {FILTERS.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
                data-testid={`shortcuts:filter-${id}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs",
                  filter === id ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`shortcutsTab.filter.${id}`)}
                <span className="text-tiny tabular-nums">{counts[id]}</span>
              </button>
            ))}
          </fieldset>
          <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {t("shortcutsTab.resultCount", { count: shown.length })}
          </span>
        </div>

        <div ref={listRef} className="mt-4 space-y-5" data-testid="shortcuts:list">
          {groups.length === 0 ? <p className="text-sm text-muted-foreground">{t("shortcutsTab.empty")}</p> : null}
          {groups.map((group) => (
            <section key={group.scope} aria-labelledby={`shortcuts-scope-${group.scope}`}>
              <h3 id={`shortcuts-scope-${group.scope}`} className="mb-1 text-xs font-medium text-muted-foreground">
                {t(SHORTCUT_SCOPE_LABEL_KEYS[group.scope])}
              </h3>
              <ul className="divide-y divide-border rounded-md border border-border">
                {group.rows.map((row) => {
                  const label = t(row.definition.labelKey);
                  const recording = recordingId === row.id;
                  const conflict = conflicts.has(row.id);
                  const rowNotice = notice?.id === row.id ? notice.notice : null;
                  const keys = row.accelerator === null
                    ? <span className="text-xs text-muted-foreground">{t("shortcutsTab.unset")}</span>
                    : <Keycaps accelerator={row.accelerator} platform={platform} />;
                  return (
                    <li key={row.id} className="flex min-w-0 items-center gap-3 px-3 py-2" data-testid={`shortcuts:row-${row.id}`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="min-w-0 truncate text-sm">{label}</span>
                          {conflict ? (
                            <span
                              className="shrink-0 rounded border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-1 text-tiny text-warning"
                              data-testid={`shortcuts:conflict-${row.id}`}
                            >
                              {t("shortcutsTab.conflict")}
                            </span>
                          ) : null}
                        </div>
                        {row.definition.readOnly ? (
                          <p className="text-dense text-muted-foreground" data-testid={`shortcuts:reason-${row.id}`}>{t(row.definition.readOnly.reasonKey)}</p>
                        ) : null}
                        {recording ? (
                          <p className="text-dense text-muted-foreground" role="status">{t("shortcutsTab.recordingHint")}</p>
                        ) : null}
                        {rowNotice ? (
                          <p className="text-dense text-destructive" role="alert" data-testid={`shortcuts:notice-${row.id}`}>{noticeText(rowNotice)}</p>
                        ) : null}
                      </div>
                      {row.rebindable ? (
                        <>
                          <button
                            type="button"
                            data-shortcut-nav=""
                            data-testid={`shortcuts:record-${row.id}`}
                            aria-label={t("shortcutsTab.recordAria", { label, keys: keyText(row) })}
                            aria-pressed={recording}
                            onClick={() => { setNotice(null); setRecordingId(recording ? null : row.id); }}
                            onBlur={() => { if (recording) setRecordingId(null); }}
                            className={cn(
                              "flex min-h-7 shrink-0 items-center rounded-md border px-1.5 py-0.5",
                              recording ? "border-primary ring-2 ring-primary/(--opacity-medium)" : "border-transparent hover:border-border",
                            )}
                          >
                            {recording ? <span className="px-1 text-xs text-foreground">{t("shortcutsTab.recording")}</span> : keys}
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 shrink-0 p-0"
                            disabled={!row.modified}
                            onClick={() => reset(row.id)}
                            aria-label={t("shortcutsTab.resetAria", { label })}
                            title={t("shortcutsTab.reset")}
                            data-testid={`shortcuts:reset-${row.id}`}
                          >
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        </>
                      ) : (
                        <div
                          tabIndex={-1}
                          data-shortcut-nav=""
                          className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          data-testid={`shortcuts:fixed-${row.id}`}
                        >
                          <span className="sr-only">{t("shortcutsTab.fixedAria", { label, keys: keyText(row) })}</span>
                          <Lock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                          {keys}
                          {/* Keeps the keycap column aligned with rebindable rows' reset button. */}
                          <span className="w-7" aria-hidden="true" />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
