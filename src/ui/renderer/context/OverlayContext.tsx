/**
 * OverlayContext — routine fire overlay queue.
 *
 * Policy:
 *   - ONE queue for the window; each tile renders its own slice of it and
 *     navigates that slice (see `OverlayCardRegion`). A window-wide "1/3" would
 *     count cards the tile does not show and step onto cards it cannot render.
 *   - dismiss (permanent removal)
 *   - snooze removed (production smoke test: UX risk)
 *   - stale fire replace: new fire for same routineId replaces all prior entries
 *   - priority bands: an alert card sits in its priority's band (low, then
 *     normal, then high, oldest first within a band); every other card counts
 *     as normal, so without alerts the queue is plain arrival order
 *
 * Isolation: only summary plus the exact routine session id flows here.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { PluginOnboardingAction } from "../../../plugins/public-contract.js";

export type OverlayItemSource =
  | { kind: "routine"; routineId: string; firedAt: string }
  // Host overlay items are delivered through main-process IPC, not a plugin-specific bridge.
  | { kind: "plugin"; pluginId: string; eventId: string }
  // MCP App `ui/message` with no turn in flight — the app may NOT wake the model on its
  // own, so its message is staged here for an explicit user click. Same insertion shape
  // as `plugin` (a `pendingPrompt` that becomes an `imported_trigger` on confirm), with
  // its own provenance: the prompt is wrapped in `<app-message source="app:<serverId>">`.
  | { kind: "app"; serverId: string; eventId: string }
  // A declared plugin alert the host rendered from the kind's templates. An
  // insertion card like `plugin`; `alertId` is the host's keyed identity for
  // (plugin, kind, key), so a re-raise refreshes the card instead of adding one.
  | { kind: "alert"; pluginId: string; kindId: string; alertId: string }
  // A plugin's onboarding proposal, staged by main once the tour gate opens.
  // It ASKS rather than stages: it carries no `pendingPrompt` and starts no
  // turn, and `action` is what accepting it does — performed by the host.
  | {
      kind: "proposal";
      pluginId: string;
      proposalId: string;
      action: PluginOnboardingAction;
    };

export type OverlayPriority = "low" | "normal" | "high";

const PRIORITY_RANK: Record<OverlayPriority, number> = { low: 0, normal: 1, high: 2 };

function priorityRank(item: OverlayItem): number {
  if (item.source.kind !== "alert") return PRIORITY_RANK.normal;
  return item.priority === "low" || item.priority === "high"
    ? PRIORITY_RANK[item.priority]
    : PRIORITY_RANK.normal;
}

/**
 * Put `item` at the end of its priority band. The queue is kept band-sorted,
 * so this is the arrival-order position among cards of the same rank, and a
 * refreshed alert moves to the top of its band.
 */
function insertByPriority(queue: readonly OverlayItem[], item: OverlayItem): OverlayItem[] {
  const rank = priorityRank(item);
  const at = queue.findIndex((it) => priorityRank(it) > rank);
  return at === -1 ? [...queue, item] : [...queue.slice(0, at), item, ...queue.slice(at)];
}

export interface OverlayItem {
  /** Unique id: `${source.kind}-${unique}` */
  id: string;
  source: OverlayItemSource;
  /** Host-resolved name for an alert card; absent for other overlay sources. */
  pluginDisplayName?: string;
  title: string;
  summary: string;

  running: boolean;

  primaryActionLabel?: string;
  /** routine-specific — unified conversation session id */
  routineSessionId?: string;
  /**
   * Plugin insertion overlay — prompt to inject into main chat when the
   * user confirms (primary action). Absent for routine-source items.
   */
  pendingPrompt?: string;
  /**
   * Where an `alert` card sits in the queue: `high` above `normal` above
   * `low`. Read for alert cards only; every other card counts as `normal`.
   */
  priority?: OverlayPriority;
  /**
   * When the card came into being, as an ISO timestamp.
   *
   * Required, and never minted at render: an insertion card shows this as its
   * relative time, and a card that re-derived "now" whenever it was re-rendered
   * — a routine's spinner being replaced by its result, or its tile coming
   * back into the tree with the card still parked in it — would reset its own
   * age in front of the user. Main stamps it on the two emit paths; a routine item takes the
   * instant it fired.
   */
  createdAt: string;
  /**
   * The conversation this card CAME FROM, when main knew one.
   *
   * An MCP app card is raised by a card mounted in a specific conversation, so
   * it belongs to whichever tile is holding that conversation. A routine fires
   * on a schedule and a plugin trigger fires on an event — neither has a
   * conversation behind it, and both leave this absent, which is what makes
   * them the focused tile's to show.
   *
   * NOT `source.eventId`: that identifies the plugin EVENT, not a session.
   */
  originSessionId?: string;
}

export interface OverlayContextValue {
  /**
   * Every live card, in priority bands and oldest first within a band. The WINDOW's queue: which of these a given
   * tile shows, and which one of those is active there, is that tile's own
   * question — see `OverlayCardRegion`.
   */
  queue: readonly OverlayItem[];
  /** Permanently remove from queue */
  dismiss: (id: string) => void;
  /** Add or update an overlay item. Replaces existing entry with same source key. */
  addFire: (item: OverlayItem) => void;
  /** Open routine conversation session by exact unified session id. */
  openSession: (sessionId: string) => Promise<boolean>;
  /**
   * Cards the user has expanded, by id.
   *
   * Held here rather than inside the card because the card UNMOUNTS whenever it
   * changes surface — focus moves to another pane, or its origin conversation
   * is re-opened in another tile — and a summary the user opened must not
   * close itself because the layout moved around it.
   */
  expandedCardIds: ReadonlySet<string>;
  setCardExpanded: (id: string, expanded: boolean) => void;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function OverlayContextProvider({
  children,
  onOpenSession,
  addFireRef,
  dismissRef,
  runningRoutines,
  onQueueChange,
}: {
  children: ReactNode;
  onOpenSession: (sessionId: string) => boolean | Promise<boolean>;
  /**
   * Optional ref that App.tsx populates so it can call addFire() from
   * outside the React tree (e.g. from an IPC subscription useEffect).
   * The ref is set synchronously during render, before any effects fire.
   */
  addFireRef?: RefObject<((item: OverlayItem) => void) | null>;
  /**
   * The same, for dismiss(): main withdraws a card it staged (an alert the
   * plugin withdrew, or one that expired) by id, from outside the React tree.
   */
  dismissRef?: RefObject<((id: string) => void) | null>;
  /**
   * C1: Set of currently-running routine IDs from App.tsx runningRoutines state.
   * Provider syncs queue items' running flag when this set changes.
   */
  runningRoutines?: Set<string>;
  /**
   * The queue, handed back up to the window that renders this provider. The
   * window sits ABOVE the provider and cannot read the context, but it has to
   * know which cards name a conversation no pane is drawing — those are the
   * ones the sidebar marks rather than any pane draws.
   */
  onQueueChange?: (queue: readonly OverlayItem[]) => void;
}) {
  const [queue, setQueue] = useState<OverlayItem[]>([]);
  const [expandedCardIds, setExpandedCardIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    onQueueChange?.(queue);
  }, [queue, onQueueChange]);

  // C1: sync running flag from runningRoutines set whenever it changes
  useEffect(() => {
    if (!runningRoutines) return;
    setQueue((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (item.source.kind !== "routine") return item;
        const isRunning = runningRoutines.has(item.source.routineId);
        if (isRunning !== item.running) {
          changed = true;
          return { ...item, running: isRunning };
        }
        return item;
      });
      return changed ? next : prev;
    });
  }, [runningRoutines]);

  const addFire = useCallback((item: OverlayItem) => {
    setQueue((prev) => {
      // Stale fire replace: source.kind === "routine" + same routineId → replace;
      // source.kind === "plugin" + same (pluginId, eventId) → replace;
      // source.kind === "proposal" + same (pluginId, proposalId) → replace;
      // source.kind === "alert" + same alertId → replace (a refresh).
      // Stale guard: for routine items, only replace if incoming firedAt >= existing firedAt.
      // Date.parse() defensive comparison — handles any ISO string normalisation differences.
      // Invalid timestamp on incoming item → drop (stale-by-default); invalid existing → accept incoming.
      let dominated = false;
      const filtered = prev.filter((it) => {
        if (item.source.kind === "routine" && it.source.kind === "routine") {
          if (it.source.routineId !== item.source.routineId) return true;
          // Same routineId: compare timestamps.
          const itemTime = Date.parse(item.source.firedAt);
          const existingTime = Date.parse(it.source.firedAt);
          // Incoming has invalid timestamp — treat as stale, keep existing.
          if (!Number.isFinite(itemTime)) {
            dominated = true;
            return true;
          }
          // Both valid and incoming is strictly older — keep existing.
          if (Number.isFinite(existingTime) && itemTime < existingTime) {
            dominated = true;
            return true;
          }
          return false; // drop existing, incoming is newer (or existing timestamp invalid)
        }
        if (item.source.kind === "alert" && it.source.kind === "alert") {
          return it.source.alertId !== item.source.alertId;
        }
        if (item.source.kind === "plugin" && it.source.kind === "plugin") {
          const replaced = it.source.pluginId === item.source.pluginId
            && it.source.eventId === item.source.eventId;
          return !replaced;
        }
        // A proposal is one QUESTION, and main may stage it again — a second
        // window opening, or a re-list after an answer. Two cards asking the
        // same thing would take two answers for one stored key, so the newer
        // push replaces the older card rather than joining it.
        if (item.source.kind === "proposal" && it.source.kind === "proposal") {
          const replaced = it.source.pluginId === item.source.pluginId
            && it.source.proposalId === item.source.proposalId;
          return !replaced;
        }
        return true;
      });
      if (dominated) return prev; // stale replay — discard
      return insertByPriority(filtered, item);
    });
  }, []);

  // Expose addFire via ref so App.tsx can call it from IPC subscription
  if (addFireRef) {
    // Safe: synchronous assignment during render, before effects
    addFireRef.current = addFire;
  }

  const dismiss = useCallback((id: string) => {
    setQueue((prev) => prev.filter((it) => it.id !== id));
    // A dismissed card's expansion has nothing left to describe; keeping it
    // would silently pre-expand a later card that reused the id.
    setExpandedCardIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  if (dismissRef) {
    // Safe: synchronous assignment during render, before effects
    dismissRef.current = dismiss;
  }

  const setCardExpanded = useCallback((id: string, expanded: boolean) => {
    setExpandedCardIds((prev) => {
      if (prev.has(id) === expanded) return prev;
      const next = new Set(prev);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const openSession = useCallback(
    (sessionId: string) => Promise.resolve(onOpenSession(sessionId)),
    [onOpenSession],
  );

  const value = useMemo<OverlayContextValue>(
    () => ({ queue, dismiss, addFire, openSession, expandedCardIds, setCardExpanded }),
    [queue, dismiss, addFire, openSession, expandedCardIds, setCardExpanded],
  );

  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

export function useOverlayContext(): OverlayContextValue {
  const v = useContext(OverlayContext);
  if (!v) throw new Error("useOverlayContext must be used within OverlayContextProvider");
  return v;
}
