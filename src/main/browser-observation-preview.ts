import type { WebContents } from "electron";
import { BrowserScreencast, type ScreencastCallbacks, type ScreencastTransport } from "../observation/browser-screencast.js";

/** The parts of an agent guest a preview uses: its already attached page session and main-frame commits. */
export type PreviewGuest = Pick<WebContents, "id" | "isDestroyed" | "debugger" | "on" | "removeListener" | "once">;

export interface BrowserPreviewHandle {
  rendered(frame: number): void;
  stop(): Promise<void>;
}

/**
 * Reuses the agent's in-process debugger session for this guest. A guest without that session has never been driven
 * by the agent, so no preview attaches a debugger or opens any other remote debugging surface.
 */
export function startBrowserPreview(guest: PreviewGuest, callbacks: ScreencastCallbacks): BrowserPreviewHandle {
  if (guest.isDestroyed() || !guest.debugger.isAttached()) throw new Error("Browser preview requires the agent's page session.");
  const transport: ScreencastTransport = {
    send: (method, params) => guest.debugger.sendCommand(method, params ?? {}) as Promise<unknown>,
    onEvent: (listener) => {
      const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => listener(method, params);
      guest.debugger.on("message", onMessage);
      return () => { guest.debugger.removeListener("message", onMessage); };
    },
    onClose: (listener) => {
      const detached = (_event: unknown, reason: string) => listener(reason || "detached");
      const destroyed = () => listener("target-destroyed");
      guest.debugger.on("detach", detached);
      guest.once("destroyed", destroyed);
      return () => { guest.debugger.removeListener("detach", detached); guest.removeListener("destroyed", destroyed); };
    },
  };
  // `did-navigate` is main-frame only and fires at commit; same-document navigation keeps its screencast client.
  const committed = (): void => screencast.navigationCommitted();
  const screencast = new BrowserScreencast(transport, { ...callbacks, ended: (error) => {
    guest.removeListener("did-navigate", committed);
    callbacks.ended(error);
  } });
  guest.on("did-navigate", committed);
  screencast.start();
  return {
    rendered: (frame) => screencast.rendered(frame),
    stop: () => { guest.removeListener("did-navigate", committed); return screencast.stop(); },
  };
}

/** Samples a decoded frame on a coarse grid; nearly identical pixels mean a blank or black commit paint. */
export function isUniformJpeg(data: string, decode: (buffer: Buffer) => { bitmap: Buffer; width: number; height: number } | null): boolean {
  const image = decode(Buffer.from(data, "base64"));
  if (!image || image.width === 0 || image.height === 0) return true;
  const { bitmap, width, height } = image;
  const stride = width * 4;
  let min = 255;
  let max = 0;
  const steps = 12;
  for (let y = 0; y < steps; y++) for (let x = 0; x < steps; x++) {
    const offset = Math.floor((y + 0.5) * height / steps) * stride + Math.floor((x + 0.5) * width / steps) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const value = bitmap[offset + channel] ?? 0;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return max - min <= 6;
}
