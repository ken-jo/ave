import type { CdpSession } from "./browser-action-guard.js";

/** Fixed read-only admission probe; no page or tool input becomes executable code. */
export async function browserLayoutReady(session: CdpSession): Promise<boolean> {
  const result = await session.send("Runtime.evaluate", {
    expression: "({ width: innerWidth, height: innerHeight, visible: document.visibilityState !== 'hidden' })", returnByValue: true,
  }) as { result?: { value?: { width?: number; height?: number; visible?: boolean } } };
  const viewport = result.result?.value;
  return !!viewport && (viewport.width ?? 0) > 0 && (viewport.height ?? 0) > 0 && viewport.visible === true;
}
