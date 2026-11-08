import {
  DEFAULT_ACCESSIBILITY_SIGNAL_MODES,
  resolveAccessibilitySignalModes,
  shouldPlayAccessibilitySignal,
  type AccessibilitySignalId,
  type AccessibilitySignalMode,
} from "../../shared/accessibility-signals.js";
import { useCallback } from "react";
import type { AppSettings } from "./types.js";
import { playAccessibilitySignalSound } from "./accessibility-signal-sounds.js";
import { useSettingsSnapshot, type SettingsSnapshotApi } from "./hooks/use-settings-snapshot.js";

/** How many event keys the engine remembers for once-per-event playback. One key per turn or decision card; a window would
 * have to outlive this many events before an old key could be seen again, and none is ever re-sent that late. */
const REMEMBERED_EVENT_KEYS = 512;

export interface AccessibilitySignalEngineDeps {
  /** Whether the main window has focus right now (`document.hasFocus()`). */
  isWindowFocused: () => boolean;
  play: (id: AccessibilitySignalId) => Promise<void>;
}

/**
 * The window's one accessibility signal player. Every event source reports here with a key naming the event, so a turn or a
 * card drawn by several tiles still sounds once. The engine owns the mode check and the focus check; the sources only decide
 * which events are the agent's (a user's own action never reaches here).
 */
export class AccessibilitySignalEngine {
  private modes: Record<AccessibilitySignalId, AccessibilitySignalMode> = { ...DEFAULT_ACCESSIBILITY_SIGNAL_MODES };
  private readonly seen = new Set<string>();

  constructor(private readonly deps: AccessibilitySignalEngineDeps) {}

  setModes(modes: Record<AccessibilitySignalId, AccessibilitySignalMode>): void {
    this.modes = { ...modes };
  }

  /** Report an agent event. Returns whether a sound was started. */
  signal(id: AccessibilitySignalId, eventKey: string): boolean {
    if (this.seen.has(eventKey)) return false;
    this.seen.add(eventKey);
    if (this.seen.size > REMEMBERED_EVENT_KEYS) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    if (!shouldPlayAccessibilitySignal(this.modes[id], this.deps.isWindowFocused())) return false;
    this.start(id);
    return true;
  }

  /** The Settings "play" button: the user asked to hear it, so mode and focus do not apply. */
  preview(id: AccessibilitySignalId): Promise<void> {
    return this.deps.play(id);
  }

  private start(id: AccessibilitySignalId): void {
    // A cue that cannot play must not break the event that raised it; the failure is reported, not hidden.
    void this.deps.play(id).catch((err: unknown) => {
      console.warn(`[accessibility-signal] ${id} did not play:`, err instanceof Error ? err.message : String(err));
    });
  }
}

let windowEngine: AccessibilitySignalEngine | null = null;

export function getAccessibilitySignalEngine(): AccessibilitySignalEngine {
  windowEngine ??= new AccessibilitySignalEngine({
    isWindowFocused: () => document.hasFocus(),
    play: (id) => playAccessibilitySignalSound(id),
  });
  return windowEngine;
}

/** Keep the window engine on the stored modes; a Settings change applies to the next event. */
export function useAccessibilitySignalModes(api: SettingsSnapshotApi): void {
  const apply = useCallback((settings: AppSettings) => {
    getAccessibilitySignalEngine().setModes(resolveAccessibilitySignalModes(settings.system));
  }, []);
  useSettingsSnapshot(api, apply);
}

/** Test seam: install an engine with injected focus and player, or clear it. */
export function setAccessibilitySignalEngineForTest(engine: AccessibilitySignalEngine | null): void {
  windowEngine = engine;
}

interface TurnStreamFrame {
  type: string;
  streamId?: number;
  route?: "command";
}

/**
 * Follows one chat group's stream and names the turn signal each terminal frame earns, at most one per turn. A turn ends with
 * `error` and/or `done`; whichever lands first settles it, and the rest of that turn is silent. A turn the user stopped
 * earns nothing (stop button, or a send that interrupts it), and neither does a slash command (the user's own action, answered
 * at once). When frames carry stream ids, a higher id is a new turn: it retires the open one even if that turn's own closing
 * frame never arrives, so a superseded turn neither chimes late nor silences its successor.
 */
export class TurnSignalTracker {
  // Start unsettled: a window that reloads mid-turn still hears that turn end.
  private settled = false;
  private userStopped = false;
  private turnSeq = 0;
  private openStreamId: number | null = null;
  private lastSettledStreamId: number | null = null;

  constructor(private readonly groupKey: string) {}

  /** The user stopped or interrupted the running turn; the frames that close it are theirs. */
  noteUserStop(): void {
    this.userStopped = true;
  }

  /** The host refused the interrupting send, so the running turn goes on and its end is the agent's again. */
  clearUserStop(): void {
    this.userStopped = false;
  }

  observe(ev: TurnStreamFrame): { id: AccessibilitySignalId; eventKey: string } | null {
    const streamId = typeof ev.streamId === "number" ? ev.streamId : null;
    // A retired stream's stragglers neither open a turn nor end one.
    if (streamId !== null && this.lastSettledStreamId !== null && streamId <= this.lastSettledStreamId) return null;
    if (streamId !== null && this.openStreamId !== null && streamId < this.openStreamId) return null;
    if (streamId !== null && this.openStreamId !== null && streamId > this.openStreamId) {
      // A newer stream is speaking: the open turn is over, whatever it still sends.
      this.lastSettledStreamId = this.openStreamId;
      this.settled = false;
      this.userStopped = false;
    }
    if (streamId !== null) this.openStreamId = streamId;
    const terminal = ev.type === "done" || ev.type === "error";
    if (!terminal) {
      if (this.settled) {
        this.settled = false;
        this.userStopped = false;
      }
      return null;
    }
    if (this.settled) return null;
    this.settled = true;
    this.turnSeq += 1;
    if (streamId !== null) this.lastSettledStreamId = streamId;
    if (this.userStopped) return null;
    if (ev.type === "done" && ev.route === "command") return null;
    const eventKey = `turn:${this.groupKey}:${streamId ?? `seq-${this.turnSeq}`}`;
    return { id: ev.type === "error" ? "turnFailed" : "turnFinished", eventKey };
  }
}
