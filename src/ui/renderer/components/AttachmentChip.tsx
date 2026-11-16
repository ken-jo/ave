import { useState } from "react";
import type { TranslateFn } from "../../../i18n/translate.js";
import { File as FileIcon, ClipboardPaste, Database, Link2, X } from "lucide-react";
import { displaySafeLabel } from "../../../shared/display-safe-text.js";
import { MCP_RESOURCE_URI_MAX_CHARS } from "../../../shared/mcp-resource-bounds.js";
import { fileMentionReferenceLabel } from "../../../shared/file-mention-reference.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover.js";
import {
  ATTACH_MAX_COUNT,
  type Attachment,
} from "../types/attachments.js";

/** Longest stretch of a pasted text the chip's view lays out. The whole text is always sent; past this the view says how
 * much it left out. */
export const PASTE_PREVIEW_MAX_CHARS = 32 * 1024;
import { collapsePath } from "../utils/attachment-markers.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatBytes } from "../../../lib/turn-summary-format.js";
import { canOpenInDefaultApp } from "../../../shared/preview-external-open.js";
import { defaultAppOpenErrorKey } from "../format-ipc-error.js";

const THUMB_MAX_PX = 48;

/**
 * Color ramp for the stacked-card visual. Each successive attachment adds a
 * new colored card behind the icon-bearing top layer, so 2-vs-5 attachments
 * are visually distinct (denser stack = more cards).
 *
 * Each entry resolves to a per-bundle `--chip-stack-N` gradient token (keyed
 * to the categorical `--chart-*` palette in styles.css), so the stack re-tints
 * with the active theme bundle instead of staying fixed light-mode pastels.
 */
const STACK_COLORS = [
  "var(--chip-stack-1)",
  "var(--chip-stack-2)",
  "var(--chip-stack-3)",
  "var(--chip-stack-4)",
  "var(--chip-stack-5)",
];

const STACK_OFFSET_PX = 2;

function ImageThumb({ att, alt }: { att: Extract<Attachment, { kind: "image" }>; alt: string }) {
  const longest = Math.max(att.width, att.height) || 1;
  const w = Math.round((att.width / longest) * THUMB_MAX_PX);
  const h = Math.round((att.height / longest) * THUMB_MAX_PX);
  return (
    <img
      src={att.dataUrl}
      alt={alt}
      width={w}
      height={h}
      style={{ width: w, height: h, objectFit: "contain" }}
      className="rounded border border-border bg-muted"
    />
  );
}

function FileThumb() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
      <FileIcon className="h-4 w-4" />
    </div>
  );
}

function PasteThumb() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) text-warning">
      <ClipboardPaste className="h-4 w-4" />
    </div>
  );
}

function ResourceThumb() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
      <Database className="h-4 w-4" />
    </div>
  );
}

function chipLabel(att: Attachment, t: TranslateFn): string {
  if (att.kind === "image") return `#${att.n}`;
  if (att.kind === "file") return att.location
    ? fileMentionReferenceLabel({ path: att.path, ...att.location })
    : collapsePath(att.name);
  if (att.kind === "resource") return att.label;
  return t("attachmentChip.pasteLines", { count: att.lines });
}

/** The attachment's kind and number in the reader's language, e.g. "Image #2". The marker in the message body stays
 * `[Image #2]` in every language: it is part of what is sent. */
function attachmentTitle(att: Attachment, t: TranslateFn): string {
  if (att.kind === "image") return t("attachmentChip.imageLabel", { n: att.n });
  if (att.kind === "file") return t("attachmentChip.fileLabel", { n: att.n });
  if (att.kind === "resource") return t("attachmentChip.resourceLabel", { n: att.n });
  return t("attachmentChip.pasteLabel", { n: att.n });
}

/** What a remove button names: the file or resource by its name, an image or pasted text by its kind and number. */
function removeLabel(att: Attachment, t: TranslateFn): string {
  const subject = att.kind === "file" ? att.name : att.kind === "resource" ? att.label : attachmentTitle(att, t);
  return t("attachmentChip.removeAttachment", { label: subject });
}

function badgeClass(count: number): string {
  if (count >= ATTACH_MAX_COUNT) return "text-destructive font-bold";
  if (count >= ATTACH_MAX_COUNT - 1) return "text-warning font-semibold";
  return "text-muted-foreground";
}

/** Stacked-card visual. Renders `layers` cards (capped to ATTACH_MAX_COUNT), each offset diagonally so density increases
 * with attachment count. The top card carries an icon; the others are bare colored cards behind it. */
function StackVisual({ layers }: { layers: number }) {
  const n = Math.max(2, Math.min(layers, ATTACH_MAX_COUNT));
  const cards = Array.from({ length: n }, (_, i) => i);
  return (
    <div className="relative h-12 w-12" data-testid="chip-stack" data-layers={n}>
      {cards.map((i) => {
        const isTop = i === n - 1;
        const left = i * STACK_OFFSET_PX;
        const top = (n - 1 - i) * STACK_OFFSET_PX;
        if (isTop) {
          return (
            <div
              key={i}
              style={{ left, top, width: 40, height: 40 }}
              className="absolute flex items-center justify-center rounded-md border border-background bg-muted text-muted-foreground shadow"
            >
              <FileIcon className="h-4 w-4" />
            </div>
          );
        }
        return (
          <div
            key={i}
            style={{
              left,
              top,
              width: 40,
              height: 40,
              backgroundImage: STACK_COLORS[i % STACK_COLORS.length],
            }}
            className="absolute rounded-md border border-background shadow"
          />
        );
      })}
    </div>
  );
}

/**
 * Single chip — used when there is exactly one attachment. The whole chip
 * is a popover trigger so the user can inspect the file path and open the
 * file in the OS's default app, matching the multi-attachment overlay UX.
 *
 * Path references use a removable inline chip. Ordinary attachments keep
 * their popover and carry a remove button beside it. Removing either kind
 * also removes its composer marker.
 */
export function AttachmentChip({
  attachment,
  total,
  onOpenExternal,
  onRemove,
}: {
  attachment: Attachment;
  /** Composer slots in use (`attachmentSlotsUsed`), which the badge counts against the limit. */
  total: number;
  onOpenExternal?: OpenAttachmentExternally;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (attachment.kind === "file" && attachment.reference && onRemove) {
    const label = attachment.location ? fileMentionReferenceLabel({ path: attachment.path, ...attachment.location })
      : /^(?:[/\\]|[a-zA-Z]:[/\\])/.test(attachment.path) ? attachment.name : attachment.path;
    return (
      <span data-testid="attachment-chip" className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-lg bg-(--file-reference-bg) py-0.5 pl-2 pr-0.5 text-(--file-reference-fg)"
        title={attachment.location ? t("attachmentChip.locationSourceTurn", { turn: attachment.location.turnId }) : label}>
        <Link2 aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span data-testid="chip-count-badge" className="min-w-0 truncate font-mono text-xs">@{label}</span>
        <button type="button" onClick={onRemove} aria-label={t("attachmentChip.removeReference", { label })}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md hover:bg-primary/(--opacity-subtle) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--file-reference-fg)">
          <X aria-hidden="true" className="h-3 w-3" />
        </button>
      </span>
    );
  }
  return (
    // The remove button is the chip's sibling, not its child: the chip is itself a button.
    <span className="relative inline-flex">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="attachment-chip"
          aria-label={t("attachmentChip.chipAriaLabel", { label: chipLabel(attachment, t) })}
          className="flex max-w-20 flex-col items-center gap-1 rounded-sm select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          title={attachment.kind === "file" && attachment.location
            ? t("attachmentChip.locationSourceTurn", { turn: attachment.location.turnId })
            : t("attachmentChip.chipTitle")}
        >
          {attachment.kind === "image" ? (
            <ImageThumb att={attachment} alt={attachmentTitle(attachment, t)} />
          ) : attachment.kind === "file" ? (
            <FileThumb />
          ) : attachment.kind === "resource" ? (
            <ResourceThumb />
          ) : (
            <PasteThumb />
          )}
          <span
            className={`max-w-full truncate text-tiny font-mono ${badgeClass(total)}`}
            data-testid="chip-count-badge"
            title={`${chipLabel(attachment, t)} · ${total}/${ATTACH_MAX_COUNT}`}
          >
            {chipLabel(attachment, t)} · {total}/{ATTACH_MAX_COUNT}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        data-testid="attachment-overlay"
        className="w-[380px] p-2"
      >
        <AttachmentOverlay
          attachments={[attachment]}
          onOpenExternal={onOpenExternal}
          onRemove={onRemove}
        />
      </PopoverContent>
    </Popover>
    {onRemove ? (
      <button
        type="button"
        data-testid="attachment-chip-remove"
        onClick={onRemove}
        aria-label={removeLabel(attachment, t)}
        title={removeLabel(attachment, t)}
        className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden="true" className="h-3 w-3" />
      </button>
    ) : null}
    </span>
  );
}

/**
 * Stacked-card chip — used when there are 2+ attachments. The visible layer
 * count scales 1:1 with attachments.length (capped at ATTACH_MAX_COUNT) so
 * 2-vs-5 attachments are visually distinct. Click opens the same overlay as
 * the single-chip variant.
 */
export function AttachmentChipCollapsed({
  attachments,
  slotsUsed,
  onOpenExternal,
  onRemove,
}: {
  attachments: Attachment[];
  /** Composer slots in use (`attachmentSlotsUsed`), which the badge counts against the limit. */
  slotsUsed: number;
  onOpenExternal?: OpenAttachmentExternally;
  /** Remove one attachment and its marker; each row of the list gets a button for it. */
  onRemove?: (attachment: Attachment) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const total = attachments.length;
  const isFull = slotsUsed >= ATTACH_MAX_COUNT;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="attachment-chip-collapsed"
          aria-label={t("attachmentChip.collapsedAriaLabel", { total })}
          className="flex max-w-20 flex-col items-center gap-1 rounded-sm select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          title={t("attachmentChip.collapsedTitle")}
        >
          <StackVisual layers={total} />
          <span
            className={`max-w-full truncate text-tiny font-mono ${badgeClass(slotsUsed)}`}
            data-testid="chip-count-badge"
          >
            {isFull
              ? t("attachmentChip.badgeFull", { used: slotsUsed, max: ATTACH_MAX_COUNT })
              : `${slotsUsed}/${ATTACH_MAX_COUNT}`}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        data-testid="attachment-overlay"
        className="w-[380px] p-2"
      >
        <AttachmentOverlay
          attachments={attachments}
          onOpenExternal={onOpenExternal}
          onRemove={onRemove}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Overlay body — listed by attachment N, each row shows thumbnail + name +
 * collapsed path + meta. The "open externally" action delegates to the host
 * via window.ave.attach.openExternal (passed in as callback). With `onRemove`
 * each row has a remove button; deleting the marker text removes it too.
 */
/** Hand an attached file to the OS default app (`attach.openExternal`). */
export type OpenAttachmentExternally = (path: string) => Promise<{ ok: boolean; error?: string }>;

export function AttachmentOverlay({
  attachments,
  onOpenExternal,
  onRemove,
}: {
  attachments: Attachment[];
  onOpenExternal?: OpenAttachmentExternally;
  onRemove?: (attachment: Attachment) => void;
}) {
  const { t } = useTranslation();
  // The i18n key of each attachment's last refused or failed open, by path.
  const [openErrors, setOpenErrors] = useState<Record<string, string | null>>({});
  return (
    <div data-testid="attachment-overlay-body">
      <div className="mb-2 flex items-center justify-between border-b border-border pb-1.5">
        <span className="text-xs font-semibold text-muted-foreground">
          {t("attachmentChip.overlayCount", { count: attachments.length })}
        </span>
        <span className="text-tiny text-muted-foreground/(--opacity-stronger)">
          {t("attachmentChip.overlayRemoveHint")}
        </span>
      </div>
      {/* Bounded by the room the popover actually has above the composer
          (minus its header), so a short window never pushes it off-screen. */}
      <div className="max-h-[min(60vh,calc(var(--radix-popover-content-available-height)-56px))] space-y-1 overflow-y-auto">
        {attachments.map((att) => (
          <div
            key={att.id}
            data-testid="overlay-item"
            className="flex flex-wrap items-center gap-3 border-b border-muted/(--opacity-medium) py-2 last:border-b-0"
          >
            <div className="flex-shrink-0">
              {att.kind === "image" ? (
                <img
                  src={att.dataUrl}
                  alt={attachmentTitle(att, t)}
                  className="h-9 w-9 rounded object-contain"
                />
              ) : att.kind === "file" ? (
                <FileThumb />
              ) : att.kind === "resource" ? (
                <ResourceThumb />
              ) : (
                <PasteThumb />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">
                {attachmentTitle(att, t)}
              </div>
              <div
                className="truncate font-mono text-tiny text-muted-foreground"
                title={att.kind === "file" && att.location
                  ? t("attachmentChip.locationSourceTurn", { turn: att.location.turnId })
                  : att.kind === "image" || att.kind === "file" ? att.path : undefined}
              >
                {att.kind === "image"
                  ? collapsePath(att.path)
                  : att.kind === "file"
                    ? att.location ? fileMentionReferenceLabel({ path: att.path, ...att.location }) : collapsePath(att.path)
                    : att.kind === "resource"
                      ? displaySafeLabel(att.uri, MCP_RESOURCE_URI_MAX_CHARS)
                      : t("attachmentChip.pasteLinesChars", { lines: att.lines, chars: att.chars })}
              </div>
              <div className="text-tiny text-muted-foreground/(--opacity-stronger)">
                {att.kind === "image"
                  ? `${att.mimeType} · ${att.width}×${att.height} · ${formatBytes(att.bytes)}`
                  : att.kind === "file"
                    ? att.location
                      ? t("attachmentChip.locationSourceTurn", { turn: att.location.turnId })
                      : `${att.ext.toUpperCase()} · ${formatBytes(att.bytes)}`
                    : att.kind === "resource"
                      ? t(att.truncated
                        ? "attachmentChip.resourceClipped"
                        : "attachmentChip.resourceFromServer", { server: att.serverId })
                      : t("attachmentChip.pastedFromClipboard")}
              </div>
            </div>
            {/* A `@file` mention is a reference main never authorized for
                open-in-OS (only picker / redeemed-drop paths are), so it has no
                open button rather than one that would be refused. */}
            {(att.kind === "image" || (att.kind === "file" && !att.reference)) && onOpenExternal && canOpenInDefaultApp(att.path) ? (
              <button
                type="button"
                onClick={() => {
                  setOpenErrors((current) => ({ ...current, [att.path]: null }));
                  void onOpenExternal(att.path).then(
                    (result) => { if (!result.ok) setOpenErrors((current) => ({ ...current, [att.path]: defaultAppOpenErrorKey(result.error) })); },
                    () => setOpenErrors((current) => ({ ...current, [att.path]: defaultAppOpenErrorKey(undefined) })),
                  );
                }}
                className="flex-shrink-0 rounded border border-border px-2 py-1 text-tiny hover:bg-muted"
                title={t("attachmentChip.openExternalTitle")}
              >
                ↗ {t("attachmentChip.openExternalButton")}
              </button>
            ) : null}
            {onRemove ? (
              <button
                type="button"
                data-testid="overlay-item-remove"
                onClick={() => onRemove(att)}
                aria-label={removeLabel(att, t)}
                title={removeLabel(att, t)}
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            ) : null}
            {(att.kind === "image" || att.kind === "file") && openErrors[att.path] ? (
              <div role="alert" data-testid="overlay-open-error" className="w-full basis-full text-tiny text-destructive">
                {t(openErrors[att.path]!)}
              </div>
            ) : null}
            {/* The chip stands in for the text in the body; opening it shows
                exactly what will be sent, selectable for a copy. */}
            {att.kind === "paste" ? (
              <pre
                data-testid="overlay-paste-text"
                aria-label={t("attachmentChip.pastedTextOriginal", { n: att.n })}
                tabIndex={0}
                // One scroller: the list around it already scrolls, and a second one inside would swallow the wheel.
                className="w-full basis-full select-text whitespace-pre-wrap break-words rounded border border-border bg-muted/(--opacity-medium) p-2 font-mono text-dense leading-relaxed text-foreground"
              >
                {/* A clipboard paste is stored whole, however long; laying out
                    megabytes of wrapped text would freeze the window, so the
                    view stops at PASTE_PREVIEW_MAX_CHARS and says how much it left out. */}
                {att.text.length > PASTE_PREVIEW_MAX_CHARS ? att.text.slice(0, PASTE_PREVIEW_MAX_CHARS) : att.text}
              </pre>
            ) : null}
            {att.kind === "paste" && att.text.length > PASTE_PREVIEW_MAX_CHARS ? (
              <div data-testid="overlay-paste-more" className="w-full basis-full text-tiny text-muted-foreground">
                {t("attachmentChip.pastedTextMore", { count: att.text.length - PASTE_PREVIEW_MAX_CHARS })}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
