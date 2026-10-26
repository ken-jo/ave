import { useState } from "react";
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

function ImageThumb({ att }: { att: Extract<Attachment, { kind: "image" }> }) {
  const longest = Math.max(att.width, att.height) || 1;
  const w = Math.round((att.width / longest) * THUMB_MAX_PX);
  const h = Math.round((att.height / longest) * THUMB_MAX_PX);
  return (
    <img
      src={att.dataUrl}
      alt={`Image #${att.n}`}
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
      <FileIcon className="h-5 w-5" />
    </div>
  );
}

function PasteThumb() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) text-warning">
      <ClipboardPaste className="h-5 w-5" />
    </div>
  );
}

function ResourceThumb() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
      <Database className="h-5 w-5" />
    </div>
  );
}

function chipLabel(att: Attachment): string {
  if (att.kind === "image") return `#${att.n}`;
  if (att.kind === "file") return att.location
    ? fileMentionReferenceLabel({ path: att.path, ...att.location })
    : collapsePath(att.name);
  if (att.kind === "resource") return att.label;
  return `+${att.lines} lines`;
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
 * Path references use a removable inline chip. Ordinary attachments retain
 * their popover; removing a reference also removes its composer marker.
 */
export function AttachmentChip({
  attachment,
  total,
  onOpenExternal,
  onRemove,
}: {
  attachment: Attachment;
  total: number;
  onOpenExternal?: (path: string) => void;
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="attachment-chip"
          aria-label={t("attachmentChip.chipAriaLabel", { label: chipLabel(attachment) })}
          className="flex max-w-20 flex-col items-center gap-1 rounded-sm select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          title={attachment.kind === "file" && attachment.location
            ? t("attachmentChip.locationSourceTurn", { turn: attachment.location.turnId })
            : t("attachmentChip.chipTitle")}
        >
          {attachment.kind === "image" ? (
            <ImageThumb att={attachment} />
          ) : attachment.kind === "file" ? (
            <FileThumb />
          ) : attachment.kind === "resource" ? (
            <ResourceThumb />
          ) : (
            <PasteThumb />
          )}
          <span
            className={`max-w-full truncate text-[10px] font-mono ${badgeClass(total)}`}
            data-testid="chip-count-badge"
            title={`${chipLabel(attachment)} · ${total}/${ATTACH_MAX_COUNT}`}
          >
            {chipLabel(attachment)} · {total}/{ATTACH_MAX_COUNT}
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
        />
      </PopoverContent>
    </Popover>
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
  onOpenExternal,
}: {
  attachments: Attachment[];
  onOpenExternal?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const total = attachments.length;
  const isFull = total >= ATTACH_MAX_COUNT;
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
            className={`max-w-full truncate text-[10px] font-mono ${badgeClass(total)}`}
            data-testid="chip-count-badge"
          >
            {total}/{ATTACH_MAX_COUNT}
            {isFull ? " full" : ""}
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
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Overlay body — listed by attachment N, each row shows thumbnail + name +
 * collapsed path + meta. The "open externally" action delegates to the host
 * via window.ave.attach.openExternal (passed in as callback).
 *
 * No remove buttons: removal is exclusively via deleting the marker text.
 */
export function AttachmentOverlay({
  attachments,
  onOpenExternal,
}: {
  attachments: Attachment[];
  onOpenExternal?: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="attachment-overlay-body">
      <div className="mb-2 flex items-center justify-between border-b border-border pb-1.5">
        <span className="text-xs font-semibold text-muted-foreground">
          {t("attachmentChip.overlayCount", { count: attachments.length })}
        </span>
        <span className="text-[10px] text-muted-foreground/(--opacity-stronger)">
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
                  alt={`Image #${att.n}`}
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
                {att.kind === "image"
                  ? `Image #${att.n}`
                  : att.kind === "file"
                    ? `File #${att.n}`
                    : att.kind === "resource"
                      ? `Resource #${att.n}`
                      : `Pasted text #${att.n}`}
              </div>
              <div
                className="truncate font-mono text-[10px] text-muted-foreground"
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
                      : `+${att.lines} lines · ${att.chars} chars`}
              </div>
              <div className="text-[10px] text-muted-foreground/(--opacity-stronger)">
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
            {(att.kind === "image" || (att.kind === "file" && !att.reference)) && onOpenExternal ? (
              <button
                type="button"
                onClick={() => onOpenExternal(att.path)}
                className="flex-shrink-0 rounded border border-border px-2 py-1 text-[10px] hover:bg-muted"
                title={t("attachmentChip.openExternalTitle")}
              >
                ↗ {t("attachmentChip.openExternalButton")}
              </button>
            ) : null}
            {/* The chip stands in for the text in the body; opening it shows
                exactly what will be sent, selectable for a copy. */}
            {att.kind === "paste" ? (
              <pre
                data-testid="overlay-paste-text"
                aria-label={t("attachmentChip.pastedTextOriginal", { n: att.n })}
                tabIndex={0}
                // One scroller: the list around it already scrolls, and a second one inside would swallow the wheel.
                className="w-full basis-full select-text whitespace-pre-wrap break-words rounded border border-border bg-muted/(--opacity-medium) p-2 font-mono text-[11px] leading-relaxed text-foreground"
              >
                {/* A clipboard paste is stored whole, however long; laying out
                    megabytes of wrapped text would freeze the window, so the
                    view stops at PASTE_PREVIEW_MAX_CHARS and says how much it left out. */}
                {att.text.length > PASTE_PREVIEW_MAX_CHARS ? att.text.slice(0, PASTE_PREVIEW_MAX_CHARS) : att.text}
              </pre>
            ) : null}
            {att.kind === "paste" && att.text.length > PASTE_PREVIEW_MAX_CHARS ? (
              <div data-testid="overlay-paste-more" className="w-full basis-full text-[10px] text-muted-foreground">
                {t("attachmentChip.pastedTextMore", { count: att.text.length - PASTE_PREVIEW_MAX_CHARS })}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
