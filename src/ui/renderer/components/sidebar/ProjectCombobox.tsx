import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { useTranslation } from "../../../../i18n/react.js";

/** One pickable row of a project menu or picker. */
export interface ComboboxOption {
  /** Stable within one list; also the DOM id suffix. */
  key: string;
  testId: string;
  label: string;
  icon: ReactNode;
  /** Right-hand detail: a badge, "보는 중", a relative time. */
  detail?: ReactNode;
  /** Marked as the current choice (`aria-selected`). */
  selected?: boolean;
  onPick: () => void;
}

export interface ComboboxSection {
  key: string;
  heading?: string;
  options: ComboboxOption[];
}

export interface ProjectComboboxProps {
  ariaLabel: string;
  placeholder: string;
  /** The sections for a search text; called on every keystroke. */
  sectionsFor: (query: string) => ComboboxSection[];
  /** Which option is active when the list opens; the first one otherwise. */
  initialActiveKey?: string;
  emptyText: string;
}

/**
 * The search field and list shared by the project menu (case 02) and the launcher's project picker (case 06): typing filters,
 * ↑↓ moves, Enter picks, and Esc is left to the popover, which hands focus back to the button that opened it.
 */
export function ProjectCombobox({ ariaLabel, placeholder, sectionsFor, initialActiveKey, emptyText }: ProjectComboboxProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const [query, setQuery] = useState("");
  const sections = useMemo(() => sectionsFor(query).filter((section) => section.options.length > 0), [sectionsFor, query]);
  const options = useMemo(() => sections.flatMap((section) => section.options), [sections]);
  const [activeKey, setActiveKey] = useState<string | undefined>(initialActiveKey);
  const active = options.find((option) => option.key === activeKey) ?? options[0];
  const optionId = (key: string) => `${baseId}-option-${key}`;

  const move = (delta: number) => {
    if (options.length === 0) return;
    const index = active ? options.indexOf(active) : -1;
    const next = options[(index + delta + options.length) % options.length]!;
    setActiveKey(next.key);
    document.getElementById(optionId(next.key))?.scrollIntoView?.({ block: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
    if (event.key === "Enter" && active) { event.preventDefault(); active.onPick(); }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 rounded-md border border-border px-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={active ? optionId(active.key) : undefined}
          aria-autocomplete="list"
          value={query}
          placeholder={placeholder}
          onChange={(event) => { setQuery(event.target.value); setActiveKey(undefined); }}
          onKeyDown={onKeyDown}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          data-testid="project-combobox-search"
        />
      </div>
      <div
        id={`${baseId}-list`}
        role="listbox"
        aria-label={ariaLabel}
        className="mt-1 max-h-80 min-h-0 overflow-y-auto"
      >
        {options.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">{emptyText}</p> : null}
        {sections.map((section) => (
          <div key={section.key} role="group" aria-label={section.heading} className="border-b border-border py-1 last:border-b-0">
            {section.heading ? <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{section.heading}</p> : null}
            {section.options.map((option) => (
              <div
                key={option.key}
                id={optionId(option.key)}
                role="option"
                aria-selected={option.selected === true}
                data-active={option === active ? "true" : undefined}
                data-testid={option.testId}
                onMouseMove={() => { if (option !== active) setActiveKey(option.key); }}
                // Keep focus in the search field; a click picks like Enter.
                onMouseDown={(event) => event.preventDefault()}
                onClick={option.onPick}
                className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[active=true]:bg-accent"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">{option.icon}</span>
                <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
                {option.detail ? <span className="shrink-0 text-[11px] text-muted-foreground">{option.detail}</span> : null}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="mt-1 flex items-center gap-2 border-t border-border px-2 pt-1.5 text-[11px] text-muted-foreground" aria-hidden="true">
        <kbd className="rounded border border-border px-1">↑↓</kbd>{t("sidebar.menuKeyMove")}
        <kbd className="rounded border border-border px-1">Enter</kbd>{t("sidebar.menuKeyOpen")}
        <kbd className="rounded border border-border px-1">Esc</kbd>{t("sidebar.menuKeyClose")}
      </p>
    </div>
  );
}

/** The two-letter mark a project shows where its icon would be: initials of its name's first two words, else its first two
 * letters. */
export function projectInitials(name: string): string {
  const words = name.split(/[\s\-_.]+/).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? name).slice(0, 2);
  return letters.toLowerCase();
}

/** Case-insensitive match on a project's shown name or its path. */
export function projectMatches(query: string, name: string, root: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || name.toLowerCase().includes(needle) || root.toLowerCase().includes(needle);
}

/** A project's part of a `data-testid`: its root with every run of other characters turned into one dash. */
export function projectTestId(root: string, fallback: string): string {
  const safe = (root || fallback).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "default";
}
