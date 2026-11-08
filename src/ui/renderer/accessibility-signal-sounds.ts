import type { AccessibilitySignalId } from "../../shared/accessibility-signals.js";

/**
 * Accessibility signal sounds, synthesised with WebAudio at play time. No asset files: nothing to license, nothing for the
 * packaging and asset gates to carry, and no network. Each cue is two short soft notes with a fast attack and an exponential
 * release (no click), quiet enough to sit under other audio. The three cues differ in contour so they are told apart by ear:
 * - turn finished: a rising major fourth, the "done" shape;
 * - approval needed: the same note twice, the "your turn" knock;
 * - turn failed: a falling minor third.
 */
interface SignalNote {
  /** Hz. */
  frequency: number;
  /** Seconds from the cue start. */
  at: number;
  /** Seconds. */
  duration: number;
}

interface SignalSound {
  wave: OscillatorType;
  /** Peak gain, 0..1. */
  peak: number;
  notes: readonly SignalNote[];
}

export const ACCESSIBILITY_SIGNAL_SOUNDS: Readonly<Record<AccessibilitySignalId, SignalSound>> = Object.freeze({
  turnFinished: { wave: "sine", peak: 0.12, notes: [{ frequency: 659.25, at: 0, duration: 0.12 }, { frequency: 880, at: 0.09, duration: 0.18 }] },
  approvalNeeded: { wave: "triangle", peak: 0.1, notes: [{ frequency: 783.99, at: 0, duration: 0.09 }, { frequency: 783.99, at: 0.14, duration: 0.12 }] },
  turnFailed: { wave: "sine", peak: 0.12, notes: [{ frequency: 440, at: 0, duration: 0.14 }, { frequency: 369.99, at: 0.12, duration: 0.2 }] },
});

const ATTACK_SECONDS = 0.012;
/** An exponential ramp cannot reach zero; this is inaudible. */
const SILENCE_GAIN = 0.0001;

type AudioContextFactory = () => AudioContext;

let sharedContext: AudioContext | null = null;

function defaultAudioContextFactory(): AudioContext {
  if (typeof AudioContext !== "function") throw new Error("accessibility-signal: WebAudio AudioContext is unavailable in this renderer");
  return new AudioContext();
}

/** Play one signal's sound. Resolves once the notes are scheduled on a running context; rejects if audio cannot run, so a
 * caller never mistakes a suspended context for a played cue. */
export async function playAccessibilitySignalSound(
  id: AccessibilitySignalId,
  createContext: AudioContextFactory = defaultAudioContextFactory,
): Promise<void> {
  // One context for the window's life; browsers cap how many may exist.
  sharedContext ??= createContext();
  const ctx = sharedContext;
  if (ctx.state !== "running") await ctx.resume();
  if (ctx.state !== "running") throw new Error(`accessibility-signal: audio context is ${ctx.state}`);
  const sound = ACCESSIBILITY_SIGNAL_SOUNDS[id];
  const start = ctx.currentTime;
  for (const note of sound.notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = sound.wave;
    osc.frequency.setValueAtTime(note.frequency, start + note.at);
    gain.gain.setValueAtTime(SILENCE_GAIN, start + note.at);
    gain.gain.linearRampToValueAtTime(sound.peak, start + note.at + ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(SILENCE_GAIN, start + note.at + note.duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start + note.at);
    osc.stop(start + note.at + note.duration + 0.02);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
}

export const __test = {
  reset(): void { sharedContext = null; },
};
