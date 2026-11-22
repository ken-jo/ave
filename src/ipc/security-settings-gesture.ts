import type { WebContents } from "electron";
import { createHash } from "node:crypto";
import { USER_GESTURE_LIFETIME_MS } from "../shared/chat-origin.js";

/** The one security operation a native input may authorize: the IPC channel and the exact request it carries. */
interface SecuritySettingsOperation {
  channel: string;
  payload: unknown;
}

/** Main's receipt that one native input authorized one operation. */
interface SecuritySettingsGestureProof {
  readonly sequence: number;
  readonly receivedAt: number;
  readonly channel: string;
  readonly payloadDigest: string;
}

interface NativeInputReceipt {
  sequence: number;
  receivedAt: number;
}

function payloadDigest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/**
 * Native input is observed in main; a renderer assertion alone cannot authorize a security change. Each input replaces the
 * previous receipt, so an older input can never be spent once a newer one arrived. The first operation that claims a receipt
 * spends it, and a receipt older than the preload gesture token's lifetime authorizes nothing.
 */
function createSecuritySettingsGestureTracker() {
  const now = () => Date.now();
  const observed = new WeakSet<WebContents>();
  const latest = new WeakMap<WebContents, NativeInputReceipt>();
  let sequence = 0;
  const record = (contents: WebContents) => { latest.set(contents, { sequence: ++sequence, receivedAt: now() }); };
  return {
    observe(contents: WebContents): void {
      if (observed.has(contents)) return;
      observed.add(contents);
      contents.on("before-input-event", (_event, input) => {
        if (input.type === "keyDown" && !input.isAutoRepeat) record(contents);
      });
      contents.on("before-mouse-event", (_event, input) => {
        if (input.type === "mouseDown" || input.type === "mouseUp") record(contents);
      });
      contents.on("blur", () => latest.delete(contents));
      contents.on("did-start-navigation", () => latest.delete(contents));
      contents.on("destroyed", () => latest.delete(contents));
    },
    /** Spend the latest native input on `operation`: a proof once, null for no input, a lapsed input or a spent one. */
    consume(contents: WebContents, operation: SecuritySettingsOperation): SecuritySettingsGestureProof | null {
      const receipt = latest.get(contents);
      latest.delete(contents);
      if (!receipt) return null;
      const age = now() - receipt.receivedAt;
      if (age < 0 || age > USER_GESTURE_LIFETIME_MS) return null;
      return Object.freeze({ sequence: receipt.sequence, receivedAt: receipt.receivedAt,
        channel: operation.channel, payloadDigest: payloadDigest(operation.payload) });
    },
  };
}

export const securitySettingsGestures = createSecuritySettingsGestureTracker();
