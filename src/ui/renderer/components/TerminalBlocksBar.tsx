/**
 * TerminalBlocksBar — the command-block strip above a workspace terminal.
 *
 * The main process records each command the terminal runs as a block
 * (command, directory, exit code, timing, output; main/terminal/
 * terminal-blocks.ts). This strip lists them for one tab, searches them by
 * command text (the tab's command history), and copies a block or attaches it
 * to the chat composer as a pasted-text chip.
 *
 * It only reads: nothing here writes to the PTY.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Blocks, ClipboardCopy, MessageSquarePlus } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { cn } from "../../../lib/utils.js";
import { useTranslation } from "../../../i18n/react.js";
import type { AveApi } from "../types.js";
import type { TerminalBlockSummary } from "../../../shared/terminal-blocks.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";
import { errorMessage } from "../../../shared/error-message.js";
import { formatIpcError } from "../format-ipc-error.js";
import {
  blockDurationSeconds,
  blockStatusLabel,
  filterBlocksByCommand,
  formatBlockForChat,
  formatBlockForCopy,
} from "../utils/terminal-block-text.js";

type TerminalApi = NonNullable<AveApi["terminal"]>;

/** How long "Attached" stays on the button that attached. */
const ATTACHED_FLASH_MS = 1500;

export function TerminalBlocksBar({
  terminalApi,
  tabId,
  tabLabel,
  revision,
  onAttachText,
}: {
  terminalApi: TerminalApi;
  tabId: string;
  tabLabel: string;
  /** Bumped by the terminal view whenever a block may have started or ended. */
  revision: number;
  onAttachText?: (text: string) => boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState<TerminalBlockSummary[]>([]);
  const [integrated, setIntegrated] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attachedId, setAttachedId] = useState<number | null>(null);
  const { copied, copy } = useCopyFlash();
  const attachedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (attachedTimer.current !== null) clearTimeout(attachedTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void terminalApi.listBlocks(tabId).then((res) => {
      if (cancelled || !res.ok) return;
      setBlocks(res.blocks);
      setIntegrated(res.integrated || res.blocks.length === 0);
    }).catch(() => {
      // The list is a convenience view; a failed refresh keeps the last one
      // and the next marker retries.
    });
    return () => {
      cancelled = true;
    };
  }, [terminalApi, tabId, revision]);

  const visible = useMemo(() => filterBlocksByCommand(blocks, query), [blocks, query]);
  const latestDone = useMemo(() => blocks.find((block) => block.status === "done") ?? blocks[0] ?? null, [blocks]);

  const withBlock = useCallback(
    async (blockId: number, use: (text: { chat: string; copy: string }) => void) => {
      setNotice(null);
      try {
        const res = await terminalApi.getBlock(tabId, blockId);
        if (!res.ok) {
          setNotice(t("terminalBlocks.loadFailed", { error: formatIpcError(res.error, undefined) }));
          return;
        }
        use({
          chat: formatBlockForChat(res.block, { label: tabLabel, id: tabId }, t),
          copy: formatBlockForCopy(res.block),
        });
      } catch (err) {
        setNotice(t("terminalBlocks.loadFailed", { error: errorMessage(err) }));
      }
    },
    [tabId, tabLabel, t, terminalApi],
  );

  const attach = useCallback(
    (blockId: number) => {
      if (!onAttachText) return;
      void withBlock(blockId, ({ chat }) => {
        if (!onAttachText(chat)) {
          setNotice(t("terminalBlocks.attachFull"));
          return;
        }
        setAttachedId(blockId);
        if (attachedTimer.current !== null) clearTimeout(attachedTimer.current);
        attachedTimer.current = setTimeout(() => {
          attachedTimer.current = null;
          setAttachedId(null);
        }, ATTACHED_FLASH_MS);
      });
    },
    [onAttachText, t, withBlock],
  );

  return (
    <div className="flex min-h-0 shrink-0 flex-col border-b border-border" data-testid="terminal-blocks-bar">
      <div className="flex h-8 items-center gap-1 px-1">
        <Button
          type="button"
          size="sm"
          variant={open ? "secondary" : "ghost"}
          className="h-6 gap-1 px-2"
          aria-expanded={open}
          title={t("terminalBlocks.toggleTitle")}
          onClick={() => setOpen((value) => !value)}
          data-testid="terminal-blocks-toggle"
        >
          <Blocks className="h-3.5 w-3.5" aria-hidden />
          {t("terminalBlocks.toggle")}
          <span className="tabular-nums text-muted-foreground">{blocks.length}</span>
        </Button>
        {onAttachText && latestDone ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2"
            title={t("terminalBlocks.attachLastTitle")}
            onClick={() => attach(latestDone.id)}
            data-testid="terminal-blocks-attach-last"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
            {attachedId === latestDone.id ? t("terminalBlocks.attached") : t("terminalBlocks.attachLast")}
          </Button>
        ) : null}
        {notice ? (
          <span className="min-w-0 truncate text-xs text-destructive" role="status">{notice}</span>
        ) : null}
      </div>
      {open ? (
        <div className="flex max-h-56 min-h-0 flex-col gap-1 px-1 pb-1">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("terminalBlocks.searchPlaceholder")}
            aria-label={t("terminalBlocks.searchPlaceholder")}
            className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs"
            data-testid="terminal-blocks-search"
          />
          {!integrated ? (
            <p className="text-xs text-muted-foreground">{t("terminalBlocks.heuristicNotice")}</p>
          ) : null}
          <ul
            className="min-h-0 flex-1 overflow-y-auto"
            aria-label={t("terminalBlocks.listLabel")}
            data-testid="terminal-blocks-list"
          >
            {visible.length === 0 ? (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                {blocks.length === 0 ? t("terminalBlocks.empty") : t("terminalBlocks.noMatch")}
              </li>
            ) : (
              visible.map((block) => {
                const selected = block.id === selectedId;
                const seconds = blockDurationSeconds(block);
                const failed = block.status === "done" && block.exitCode !== null && block.exitCode !== 0;
                return (
                  <li key={block.id} className={cn("rounded-md", selected && "bg-accent")}>
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left text-xs"
                      aria-pressed={selected}
                      onClick={() => setSelectedId(selected ? null : block.id)}
                      data-testid="terminal-block-row"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono" title={block.command}>
                        {block.command || "—"}
                      </span>
                      <span
                        className={cn(
                          "shrink-0",
                          failed ? "text-destructive" : block.status === "running" ? "text-muted-foreground" : "text-success",
                        )}
                      >
                        {blockStatusLabel(block, t)}
                      </span>
                      {seconds !== null ? (
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {t("terminalBlocks.durationSeconds", { seconds })}
                        </span>
                      ) : null}
                    </button>
                    {selected ? (
                      <div className="flex items-center gap-1 px-2 pb-1">
                        {block.cwd ? (
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={block.cwd}>
                            {block.cwd}
                          </span>
                        ) : (
                          <span className="flex-1" />
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 px-2"
                          title={t("terminalBlocks.copyTitle")}
                          onClick={() => void withBlock(block.id, (text) => copy(text.copy))}
                          data-testid="terminal-block-copy"
                        >
                          <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
                          {copied ? t("terminalBlocks.copied") : t("terminalBlocks.copy")}
                        </Button>
                        {onAttachText ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 gap-1 px-2"
                            title={t("terminalBlocks.attachTitle")}
                            onClick={() => attach(block.id)}
                            data-testid="terminal-block-attach"
                          >
                            <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
                            {attachedId === block.id ? t("terminalBlocks.attached") : t("terminalBlocks.attach")}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
