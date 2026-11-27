import type { WebContents } from "electron";
import { createHash } from "node:crypto";
import { USER_GESTURE_LIFETIME_MS } from "../shared/chat-origin.js";

/** The one security operation a native input may authorize: the IPC channel and the exact request it carries. */
interface SecuritySettingsOperation {
  channel: string;
  payload: unknown;
}

/** Main's receipt that one native input authorized one operation. */
export interface SecuritySettingsGestureProof {
  readonly sequence: number;
  readonly receivedAt: number;
  readonly channel: string;
  readonly payloadDigest: string;
  readonly kind: NativeInputKind;
}

export interface SecuritySettingsDecision {
  readonly surface: WebContents;
  readonly proof: SecuritySettingsGestureProof;
}

type NativeInputKind = "keyboard" | "pointer";

interface NativeInputReceipt {
  kind: NativeInputKind;
  sequence: number;
  receivedAt: number;
  spent: boolean;
  proof?: SecuritySettingsGestureProof;
  redeemed?: boolean;
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
  const record = (contents: WebContents, kind: NativeInputKind) => {
    latest.set(contents, { kind, sequence: ++sequence, receivedAt: now(), spent: false });
  };
  return {
    observe(contents: WebContents): void {
      if (observed.has(contents)) return;
      observed.add(contents);
      contents.on("before-input-event", (_event, input) => {
        if (input.type === "keyDown" && !input.isAutoRepeat) record(contents, "keyboard");
      });
      contents.on("before-mouse-event", (_event, input) => {
        if (input.type === "mouseDown" || input.type === "mouseUp") record(contents, "pointer");
      });
      contents.on("blur", () => latest.delete(contents));
      contents.on("did-start-navigation", () => latest.delete(contents));
      contents.on("destroyed", () => latest.delete(contents));
    },
    /** Spend the latest native input on `operation` if it is fresh, unspent and of the required kind. */
    consume(contents: WebContents, operation: SecuritySettingsOperation, requiredKind?: NativeInputKind): SecuritySettingsGestureProof | null {
      const receipt = latest.get(contents);
      if (!receipt || receipt.spent || (requiredKind !== undefined && receipt.kind !== requiredKind)) return null;
      receipt.spent = true;
      const age = now() - receipt.receivedAt;
      if (age < 0 || age > USER_GESTURE_LIFETIME_MS) return null;
      receipt.proof = Object.freeze({ sequence: receipt.sequence, receivedAt: receipt.receivedAt,
        channel: operation.channel, payloadDigest: payloadDigest(operation.payload), kind: receipt.kind });
      return receipt.proof;
    },
    matches(contents: WebContents, proof: SecuritySettingsGestureProof, operation: SecuritySettingsOperation): boolean {
      const age = now() - proof.receivedAt;
      return latest.get(contents)?.proof === proof && age >= 0 && age <= USER_GESTURE_LIFETIME_MS
        && proof.channel === operation.channel && proof.payloadDigest === payloadDigest(operation.payload);
    },
    redeem(decision: SecuritySettingsDecision | undefined, operation: SecuritySettingsOperation, requiredKind: NativeInputKind): WebContents | null {
      if (!decision) return null;
      const { surface, proof } = decision;
      const receipt = latest.get(surface);
      if (!receipt || receipt.redeemed || proof.kind !== requiredKind || !this.matches(surface, proof, operation)) return null;
      receipt.redeemed = true;
      return surface;
    },
  };
}

export const securitySettingsGestures = createSecuritySettingsGestureTracker();
