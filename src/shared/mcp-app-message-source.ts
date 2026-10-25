/** The envelope is provenance; shared staged-origin code owns sanitization, force-ask recognition, and slash-command containment. */
import {
  formatStagedEnvelope,
  parseStagedEnvelope,
  stagedOriginFor,
} from "./staged-origins.js";

/** Use the registry’s total row so every consumer shares the same envelope grammar. */
const APP_KIND = stagedOriginFor("app-emitted");

/** Bound source ids with the shared pattern; invalid tags must never be enveloped. */
const APP_MESSAGE_SOURCE_PATTERN = APP_KIND.sourcePattern;

export function appMessageSource(serverId: string): string {
  return `app:${serverId}`;
}

export function isAppMessageOrigin(source: string | null | undefined): boolean {
  return typeof source === "string" && APP_MESSAGE_SOURCE_PATTERN.test(source);
}

/** Throw on invalid source so unenveloped app text cannot reach the loop; shared formatting sanitizes bodies. */
export function formatAppMessageEnvelope(text: string, source: string): string {
  return formatStagedEnvelope(APP_KIND, text, source);
}

/** Return only this kind’s envelope source, never another staged kind. */
export function parseAppMessageEnvelope(input: string): string | null {
  const parsed = parseStagedEnvelope(input);
  return parsed && parsed.kind === APP_KIND ? parsed.source : null;
}
