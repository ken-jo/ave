/** Slots are untrusted data: validate and sanitize them, neutralize wrapper-closing brackets, and keep ref ids out of cards. */
import type {
  AlertInput,
  AlertKindDeclaration,
  AlertLocaleText,
  AlertSlotDeclaration,
} from "../plugins/public-contract.js";

/** An alert's dedupe key: bounded, and free of anything that could read as markup. */
export const ALERT_KEY_RE = /^[A-Za-z0-9_.:/@+=-]{1,256}$/;
const REF_RE = /^[A-Za-z0-9+/=_-]{1,256}$/;

// Include invisible, bidi, variation-selector, and separator code points.
const STRIP_CHARS_RE = new RegExp(
  "[\\u0000-\\u001f\\u007f\\u00ad\\u180e\\u200b-\\u200f\\u2028-\\u202f"
    + "\\u2060-\\u2064\\u2066-\\u2069\\ufe00-\\ufe0f\\ufeff]",
  "g",
);

/** Truncate at code-point boundaries after removing invisible and direction-changing characters. */
export function sanitizeSlotText(input: string, maxLength: number): string {
  const stripped = input.replace(STRIP_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  const codePoints = [...stripped];
  return codePoints.length > maxLength ? `${codePoints.slice(0, maxLength).join("")}…` : stripped;
}

/** Neutralize angle brackets so slot values cannot close their untrusted-data wrapper. */
function wrapUntrusted(slot: string, value: string): string {
  return `<untrusted-${slot}>${value.replace(/</g, "＜").replace(/>/g, "＞")}</untrusted-${slot}>`;
}

type SlotValue = string | readonly string[];

export type CheckedSlots = ReadonlyMap<string, SlotValue>;

function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

function checkSlot(slot: AlertSlotDeclaration, value: unknown): SlotValue | null {
  if (slot.kind === "text") {
    if (typeof value !== "string" || codePointLength(value) > slot.maxLength) return null;
    return value;
  }
  if (slot.kind === "ref") {
    return typeof value === "string" && REF_RE.test(value) ? value : null;
  }
  if (
    !Array.isArray(value)
    || value.length > slot.maxItems
    || !value.every((item) => typeof item === "string" && codePointLength(item) <= slot.maxLength)
  ) {
    return null;
  }
  return [...(value as string[])];
}

/** Reject missing, blank, oversized, or undeclared slots; report the first failing field. */
export function checkSlots(
  kind: AlertKindDeclaration,
  slots: AlertInput["slots"] | unknown,
): { ok: true; values: CheckedSlots } | { ok: false; field: string } {
  if (slots !== undefined && (typeof slots !== "object" || slots === null || Array.isArray(slots))) {
    return { ok: false, field: "slots" };
  }
  const given = (slots ?? {}) as Record<string, unknown>;
  const declared = kind.slots ?? {};
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(declared, name)) return { ok: false, field: `slots.${name}` };
  }
  const values = new Map<string, SlotValue>();
  for (const [name, slot] of Object.entries(declared)) {
    const value = Object.hasOwn(given, name) ? given[name] : undefined;
    if (value === undefined) {
      if (slot.optional === true) continue;
      return { ok: false, field: `slots.${name}` };
    }
    const checked = checkSlot(slot, value);
    if (checked === null) return { ok: false, field: `slots.${name}` };
    const blank = typeof checked === "string" ? checked.trim().length === 0 : checked.length === 0;
    if (blank && slot.optional !== true) return { ok: false, field: `slots.${name}` };
    values.set(name, checked);
  }
  return { ok: true, values };
}

/** Locale fallback is exact tag, language, then required English. */
export function localeText(text: AlertLocaleText, locale: string): string {
  const tag = locale.toLowerCase();
  if (Object.hasOwn(text, tag)) return text[tag]!;
  const language = tag.split("-")[0]!;
  if (Object.hasOwn(text, language)) return text[language]!;
  return text.en;
}

function slotCap(slot: AlertSlotDeclaration): number {
  return slot.kind === "ref" ? 256 : slot.maxLength;
}

function fill(template: string, render: (name: string) => string): string {
  return template.replace(/\{([^{}]*)\}/g, (_match, name: string) => render(name));
}

export interface RenderedAlert {
  title: string;
  summary: string;
  prompt: string;
  actionLabel: string | undefined;
  notificationBody: string;
}

export function renderAlert(kind: AlertKindDeclaration, values: CheckedSlots, locale: string): RenderedAlert {
  const declared = kind.slots ?? {};
  const plain = (name: string): string => {
    const slot = declared[name]!;
    const value = values.get(name);
    if (value === undefined) return "";
    return typeof value === "string"
      ? sanitizeSlotText(value, slotCap(slot))
      : value.map((item) => sanitizeSlotText(item, slotCap(slot))).join("; ");
  };
  const wrapped = (name: string): string => {
    const slot = declared[name]!;
    const value = values.get(name);
    if (value === undefined) return "";
    if (typeof value === "string") return wrapUntrusted(name, sanitizeSlotText(value, slotCap(slot)));
    return value
      .map((item) => `\n- ${wrapUntrusted(name, sanitizeSlotText(item, slotCap(slot)))}`)
      .join("");
  };
  const footer = Object.entries(declared)
    .filter(([name, slot]) => slot.kind === "ref" && values.has(name))
    .map(([name]) => `- ${name}: ${wrapUntrusted(name, values.get(name) as string)}`);
  const body = fill(localeText(kind.prompt, locale), wrapped).replace(/\n+$/, "");
  const title = localeText(kind.label, locale);
  return {
    title,
    summary: fill(localeText(kind.summary, locale), plain),
    prompt: footer.length === 0 ? body : `${body}\n${footer.join("\n")}`,
    actionLabel: kind.actionLabel ? localeText(kind.actionLabel, locale) : undefined,
    notificationBody: kind.osNotification
      ? localeText(kind.osNotification.body, locale)
      : kind.description
        ? localeText(kind.description, locale)
        : title,
  };
}
