/** Resource acceptance attaches server-authored content instead of composer text. Use host-projected catalogs; templates
 * open a required-field dialog and main expands the URI. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import {
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
  MCP_RESOURCE_NAME_MAX_CHARS,
} from "../../../shared/mcp-resource-bounds.js";

import { displaySafeLabel } from "../../../shared/display-safe-text.js";
import { detectMentionQuery } from "../utils/slash-trigger.js";
import { resolveIpcErrorKey } from "../format-ipc-error.js";
import type { AveApi, AveWorkspaceApi } from "../types.js";
import {
  ATTACH_MAX_COUNT,
  type FileAttachment,
  type ResourceAttachment,
} from "../types/attachments.js";

/**
 * Rows the menu will render at once.
 *
 * A server may publish 200 resources and several may be connected, so an empty query
 * matches everything: without a bound, typing `@` builds a thousand unvirtualized DOM
 * rows before the user has typed a letter of what they want. The query is how you reach
 * the rest, which is what an autocomplete is for.
 */
const MENTION_MAX_ROWS = 50;

/**
 * What accepting a row does, as a closed union rather than two optional fields.
 *
 * A resource carries a finished URI; a template carries the PATTERN and the variables to
 * ask for. Written this way so no code path can read a `uri` off a template row — the
 * distinction is the difference between a read and a form, and the two channels take
 * different arguments for a reason main enforces.
 */
type ResourceMentionTarget =
  | { kind: "resource"; uri: string }
  | { kind: "template"; uriTemplate: string; variables: readonly string[] }
  /** A workspace file main found and verified readable. Accepting it attaches a PATH REFERENCE (`[File #N]`), never content:
   * the model reads it through `read_file` and its normal permission path at turn time. */
  | { kind: "file"; path: string; relativePath: string; bytes: number };

/** Debounce between keystrokes and a workspace file query. */
const FILE_SEARCH_DEBOUNCE_MS = 120;
const NO_ROWS: ResourceMentionItem[] = [];

/** One offered row, already display-normalized. */
export interface ResourceMentionItem {
  key: string;
  serverId: string;
  /** The URI to read, or the template to fill — passed back UNCHANGED either way. */
  target: ResourceMentionTarget;
  /** Label for the eye: name/title, invisible and reordering characters removed. */
  label: string;
  /** Secondary text: `serverId` plus the same treatment of the URI or template. */
  hint: string;
  /** Picker attachability is a row-specific decision; catalog presence does not imply the host may fetch a client-owned
   * resource. */
  unavailableReason?: string;
}

export interface UseResourceMentionArgs {
  text: string;
  caret: number;
  enabled: boolean;
  isComposing: boolean;
  mcp: AveApi["mcp"] | undefined;
  /** Resource attachments already in the composer — the cap is per turn. */
  resourceCount: number;
  /** `@file` source: the main-side workspace search. Omitted on surfaces without the workspace bridge, and then no file rows
   * are offered. */
  searchFiles?: AveWorkspaceApi["searchFiles"];
  /** False when the active runtime cannot take file attachments. */
  filesEnabled: boolean;
  /** Image/file/paste attachments already in the composer — they share {@link ATTACH_MAX_COUNT}. */
  chipCount: number;
  /** Commit a file mention: same single-flushSync contract as {@link onAttach}. */
  onAttachFile: (
    attachment: FileAttachment,
    marker: string,
    range: { start: number; end: number },
    mentionToken: string,
  ) => void;
  allocateN: () => number;
  /**
   * Commit the attachment and the marker TOGETHER. The Composer owns this because the
   * two have to land in one `flushSync`: the marker-sync effect treats an attachment
   * with no marker in the body as removed and would clean it straight back up.
   */
  onAttach: (
    attachment: ResourceAttachment,
    marker: string,
    range: { start: number; end: number },
    /** The exact token the range held when the read started, for a stale check. */
    mentionToken: string,
  ) => void;
  onError: (message: string) => void;
}

/**
 * A template row the user accepted, waiting on the form.
 *
 * Carries the composer position captured at ACCEPT time, because the read happens after
 * a dialog the user may have spent a minute in. The Composer's `onAttach` re-checks that
 * position against the live text and appends instead of splicing when it has moved, so
 * this is a hint, never an authority.
 */
export interface PendingResourceTemplate {
  serverId: string;
  uriTemplate: string;
  variables: readonly string[];
  label: string;
  range: { start: number; end: number };
  mentionToken: string;
}

export interface UseResourceMentionResult {
  open: boolean;
  items: ResourceMentionItem[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  move: (delta: number) => void;
  accept: (index?: number) => void;
  close: () => void;
  /** The template awaiting values, or null. The Composer renders the dialog for it. */
  pendingTemplate: PendingResourceTemplate | null;
  /** Fill it and read. Values are the user's, keyed by the template's variable names. */
  submitTemplate: (values: Record<string, string>) => void;
  cancelTemplate: () => void;
}

interface CatalogueEntry {
  serverId: string;
  target: ResourceMentionTarget;
  label: string;
  hint: string;
  /** Lowercased haystack for matching: label + serverId + uri (or template). */
  search: string;
  unavailableReason?: string;
}

/** Stable identity for a row, and the React key. */
function targetId(target: ResourceMentionTarget): string {
  if (target.kind === "file") return target.path;
  return target.kind === "resource" ? target.uri : target.uriTemplate;
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

export function useResourceMention({
  text,
  caret,
  enabled,
  isComposing,
  mcp,
  resourceCount,
  searchFiles,
  filesEnabled,
  chipCount,
  onAttachFile,
  allocateN,
  onAttach,
  onError,
}: UseResourceMentionArgs): UseResourceMentionResult {
  const { t } = useTranslation();
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [pendingTemplate, setPendingTemplate] = useState<PendingResourceTemplate | null>(null);
  // Guards a second read while one is in flight: the accept path is async and a user can hit Enter twice, which would attach
  // the same resource under two markers.
  const attachingRef = useRef(false);

  const trigger = useMemo(
    () => (enabled && !isComposing ? detectMentionQuery(text, caret) : null),
    [enabled, isComposing, text, caret],
  );
  const triggerKey = trigger ? `${trigger.start}:${trigger.end}:${trigger.query}` : null;
  const active = trigger !== null;
  const fileQuery = trigger?.query ?? null;
  // Results carry the query they answer: during the debounce and the search the previous query's rows must not be on screen,
  // or Enter would attach a match for text the user already changed.
  const [fileResults, setFileResults] = useState<{ query: string; rows: ResourceMentionItem[] } | null>(null);
  const fileRows = fileResults !== null && fileResults.query === fileQuery ? fileResults.rows : NO_ROWS;

  // Workspace files are searched in MAIN per query (debounced), not filtered here: main owns the roots, the sensitive filter
  // and the read-scope guard, so the renderer only ever sees paths main already vouched for.
  useEffect(() => {
    if (fileQuery === null || !filesEnabled || !searchFiles) {
      setFileResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchFiles(fileQuery)
        .then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            setFileResults({ query: fileQuery, rows: NO_ROWS });
            return;
          }
          setFileResults({ query: fileQuery, rows: result.matches.map((match) => ({
            key: `file::${match.path}`,
            serverId: "",
            target: {
              kind: "file",
              path: match.path,
              relativePath: match.relativePath,
              bytes: match.bytes,
            },
            label: displaySafeLabel(basenameOf(match.relativePath), MCP_RESOURCE_NAME_MAX_CHARS),
            hint: displaySafeLabel(match.relativePath, MCP_RESOURCE_NAME_MAX_CHARS),
          })) });
        })
        .catch(() => {
          if (!cancelled) setFileResults({ query: fileQuery, rows: NO_ROWS });
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fileQuery, filesEnabled, searchFiles]);

  // Refetched whenever a mention token appears rather than cached for the session: a
  // server connects or drops between two messages, and a catalogue that outlives the
  // connection offers URIs whose read can only fail.
  //
  // Both halves in ONE effect with one `cancelled` flag. Two effects would each set the
  // catalogue and the second to land would erase the first's rows — resources and
  // templates are one list to the user, so they are one fetch here.
  useEffect(() => {
    if (!active || !mcp?.listResources) return;
    let cancelled = false;
    void (async () => {
      try {
        // Catch resource and template catalog failures independently so one unavailable source cannot erase the other.
        const unavailable = { ok: false as const, error: "unavailable" };
        const [resources, templates] = await Promise.all([
          mcp.listResources().catch(() => unavailable),
          (mcp.listResourceTemplates?.() ?? Promise.resolve(unavailable)).catch(
            () => unavailable,
          ),
        ]);
        if (cancelled) return;
        const flat: CatalogueEntry[] = [];
        if (resources.ok) {
          for (const server of resources.servers) {
            for (const resource of server.resources) {
              const label =
                displaySafeLabel(resource.title, MCP_RESOURCE_NAME_MAX_CHARS)
                || displaySafeLabel(resource.name, MCP_RESOURCE_NAME_MAX_CHARS)
                || displaySafeLabel(resource.uri, MCP_RESOURCE_NAME_MAX_CHARS);
              const safeUri = displaySafeLabel(resource.uri, MCP_RESOURCE_NAME_MAX_CHARS);
              flat.push({
                serverId: server.serverId,
                target: { kind: "resource", uri: resource.uri },
                label,
                hint: `${server.serverId} · ${safeUri}`,
                search: `${label} ${server.serverId} ${safeUri}`.toLowerCase(),
                // Shown and disabled rather than hidden. A user whose `https:` resource silently vanished from the picker would report the
                // picker as broken; a row that says why is the difference between a bug and an explanation.
                ...(resource.hostFetchRefused
                  ? { unavailableReason: t("composer.resourceNotFetchable") }
                  : {}),
              });
            }
          }
        }
        if (templates.ok) {
          for (const server of templates.servers) {
            for (const template of server.templates) {
              const label =
                displaySafeLabel(template.title, MCP_RESOURCE_NAME_MAX_CHARS)
                || displaySafeLabel(template.name, MCP_RESOURCE_NAME_MAX_CHARS)
                || displaySafeLabel(template.uriTemplate, MCP_RESOURCE_NAME_MAX_CHARS);
              const safeTemplate = displaySafeLabel(
                template.uriTemplate,
                MCP_RESOURCE_NAME_MAX_CHARS,
              );
              // `variables` comes from the HOST's discovery, derived once from the
              // template it catalogued. Deriving it here from the string would be a
              // second parser for the same grammar, and the form and the expansion
              // would eventually disagree about what the template asks for.
              flat.push({
                serverId: server.serverId,
                target: {
                  kind: "template",
                  uriTemplate: template.uriTemplate,
                  variables: template.variables,
                },
                label,
                hint: `${server.serverId} · ${safeTemplate}`,
                search: `${label} ${server.serverId} ${safeTemplate}`.toLowerCase(),
                // Same treatment as the resource row above, for the same reason: the
                // picker answers "what can be attached right now". Without this a
                // `https://…/{doc}` template looks fillable, and the refusal arrives
                // AFTER the user has filled a form — blaming the server for a host rule.
                ...(template.hostFetchRefused
                  ? { unavailableReason: t("composer.resourceNotFetchable") }
                  : {}),
              });
            }
          }
        }
        setCatalogue(flat);
      } catch {
        // A failed catalogue read is an empty menu, not an error toast: the user typed "@" and may not have meant a resource at
        // all.
        if (!cancelled) setCatalogue([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, mcp, t]);

  const items = useMemo<ResourceMentionItem[]>(() => {
    if (!trigger) return [];
    const query = trigger.query.trim().toLowerCase();
    const matched = query.length === 0
      ? catalogue
      : catalogue.filter((entry) => entry.search.includes(query));
    const resourceRows = matched.map((entry) => ({
      key: `${entry.serverId}::${entry.target.kind}::${targetId(entry.target)}`,
      serverId: entry.serverId,
      target: entry.target,
      label: entry.label,
      hint: entry.hint,
      ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
    }));
    // Files first: they are the common case of `@`, resources the specialist one.
    return [...fileRows, ...resourceRows].slice(0, MENTION_MAX_ROWS);
  }, [trigger, catalogue, fileRows]);

  useEffect(() => {
    setActiveIndex(0);
  }, [triggerKey]);

  const open = trigger !== null && items.length > 0 && dismissedToken !== triggerKey;

  const move = useCallback((delta: number) => {
    setActiveIndex((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length));
  }, [items.length]);

  const close = useCallback(() => {
    setDismissedToken(triggerKey);
  }, [triggerKey]);

  /**
   * The read, shared by both kinds of row.
   *
   * One place decides what an attachment looks like and how a failure is reported, so a
   * template attachment cannot drift into a different chip, a different marker, or a
   * hand-written error mapping. Only the round trip differs, and the caller supplies it.
   */
  const runAttach = useCallback((
    context: {
      serverId: string;
      label: string;
      uri: string;
      range: { start: number; end: number };
      mentionToken: string;
    },
    read: () => Promise<
      | { ok: true; attachment: { text: string }; uri?: string; truncated?: boolean }
      | { ok: false; error: string }
    >,
  ) => {
    if (attachingRef.current) {
      // Told, not swallowed. A silent return is survivable for a picker row — the row is
      // still there — but a template form has already taken the user's typed values and
      // closed over them, so returning quietly loses work with no explanation.
      onError(t("composer.resourceAttachBusy"));
      return;
    }
    attachingRef.current = true;
    void (async () => {
      try {
        const result = await read();
        if (!result.ok) {
          // Use the shared IPC error table so actionable refusals such as rate-limited retain their distinct meaning.
          const mapped = resolveIpcErrorKey(result.error);
          onError(t(mapped ?? "composer.resourceAttachFailed"));
          return;
        }
        const n = allocateN();
        onAttach(
          {
            id: `res-${context.serverId}-${n}`,
            n,
            kind: "resource",
            serverId: context.serverId,
            // For a template this is the URI MAIN produced, echoed back for the chip. The renderer never composes it — it has no
            // channel that would take one.
            uri: result.uri ?? context.uri,
            label: context.label,
            text: result.attachment.text,
            truncated: result.truncated === true,
          },
          `[Resource #${n}] `,
          context.range,
          context.mentionToken,
        );
      } catch {
        onError(t("composer.resourceAttachFailed"));
      } finally {
        attachingRef.current = false;
      }
    })();
  }, [allocateN, onAttach, onError, t]);

  const accept = useCallback((index?: number) => {
    // Guarded per KIND, not on `attachResource` for both. A surface exposing only one of
    // the two channels would otherwise make the other kind's rows silently inert — the
    // menu accepts the keypress and nothing happens, which reads as a broken app rather
    // than an absent capability.
    if (!trigger) return;
    const item = items[index ?? activeIndex];
    if (!item) return;
    // A row the read would refuse says so instead of spending a round-trip to fail.
    if (item.unavailableReason) {
      onError(item.unavailableReason);
      return;
    }
    // Resource rows are capped in the UI at the SAME number main enforces (checked
    // below, after the file branch), so the user is stopped by a message naming the
    // limit instead of by a refused send. Checked again when a template's form is
    // submitted, because the answer can change while that form is open.
    const range = { start: trigger.start, end: trigger.end };
    const mentionToken = text.slice(trigger.start, trigger.end);
    if (item.target.kind === "file") {
      // A reference, not a read: nothing crosses to main here. The file shares the picker's cap, not the per-turn resource
      // bound.
      if (chipCount >= ATTACH_MAX_COUNT) {
        onError(t("composer.attachLimitWarning", { max: ATTACH_MAX_COUNT }));
        return;
      }
      const n = allocateN();
      const name = basenameOf(item.target.path);
      const dot = name.lastIndexOf(".");
      onAttachFile(
        {
          id: `file-${Date.now()}-${n}`,
          n,
          kind: "file",
          path: item.target.path,
          name,
          ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
          bytes: item.target.bytes,
          reference: true,
        },
        `[File #${n}] `,
        range,
        mentionToken,
      );
      return;
    }
    if (!mcp) return;
    if (resourceCount >= MCP_RESOURCE_ATTACHMENTS_PER_TURN) {
      onError(t("composer.resourceLimit", { max: MCP_RESOURCE_ATTACHMENTS_PER_TURN }));
      return;
    }
    if (item.target.kind === "template") {
      // Resolved INSIDE the branch, so the narrowing the call needs is the same
      // expression that decided the capability is there. Hoisting it above the branch
      // needed a second unreachable `if` further down, purely because a ternary does not
      // narrow across statements — and an unreachable silent `return` three lines from a
      // silent-drop bug is how the next reader gets confused about which one is real.
      const attachTemplate = mcp.attachResourceTemplate;
      if (!attachTemplate) {
        onError(t("composer.resourceAttachFailed"));
        return;
      }
      // No read yet — a template is an offer. The menu is dismissed here so it is not sitting open behind the dialog, and the
      // position is captured now because the user is about to spend time in a form.
      setDismissedToken(triggerKey);
      setPendingTemplate({
        serverId: item.serverId,
        uriTemplate: item.target.uriTemplate,
        variables: item.target.variables,
        label: item.label,
        range,
        mentionToken,
      });
      return;
    }
    const uri = item.target.uri;
    const attachResource = mcp.attachResource;
    if (!attachResource) {
      onError(t("composer.resourceAttachFailed"));
      return;
    }
    runAttach(
      { serverId: item.serverId, label: item.label, uri, range, mentionToken },
      () => attachResource(item.serverId, uri),
    );
  }, [trigger, triggerKey, items, activeIndex, mcp, resourceCount, chipCount, allocateN, onAttachFile, onError, runAttach, t, text]);

  const cancelTemplate = useCallback(() => setPendingTemplate(null), []);

  const submitTemplate = useCallback((values: Record<string, string>) => {
    const pending = pendingTemplate;
    const attachTemplate = mcp?.attachResourceTemplate;
    if (!pending || !attachTemplate) return;
    setPendingTemplate(null);
    // Re-checked, not inherited from the accept: the form was open while the rest of the composer stayed live, and a user can
    // add attachments from another surface in that time. Refusing here costs a message; not refusing costs a send.
    if (resourceCount >= MCP_RESOURCE_ATTACHMENTS_PER_TURN) {
      onError(t("composer.resourceLimit", { max: MCP_RESOURCE_ATTACHMENTS_PER_TURN }));
      return;
    }
    runAttach(
      {
        serverId: pending.serverId,
        label: pending.label,
        // Only a fallback for the chip if main ever stops echoing the expansion; the renderer cannot expand the template itself
        // and does not try.
        uri: pending.uriTemplate,
        range: pending.range,
        mentionToken: pending.mentionToken,
      },
      () => attachTemplate(pending.serverId, pending.uriTemplate, values),
    );
  }, [mcp, onError, pendingTemplate, resourceCount, runAttach, t]);

  return {
    open,
    items,
    activeIndex,
    setActiveIndex,
    move,
    accept,
    close,
    pendingTemplate,
    submitTemplate,
    cancelTemplate,
  };
}
