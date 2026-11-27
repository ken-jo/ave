import { afterEach, beforeEach, vi } from "vitest";

export function watchPermissionEvents(
  onEvent: (event: Record<string, unknown> & { event: string }) => void,
  level: "log" | "warn" = "log",
) {
  return vi.spyOn(console, level).mockImplementation((message, data) => {
    if (typeof message === "string" && message.startsWith("[permissions] ")
      && data && typeof data.event === "string") {
      onEvent(data);
    }
  });
}

export function collectPermissionEvents() {
  const events: Array<Record<string, unknown> & { event: string }> = [];
  const collect = (event: (typeof events)[number]) => { events.push(event); };
  const info = watchPermissionEvents(collect);
  const warn = watchPermissionEvents(collect, "warn");
  return {
    events,
    restore() {
      info.mockRestore();
      warn.mockRestore();
    },
  };
}

export function trackPermissionEvents() {
  let capture: ReturnType<typeof collectPermissionEvents>;
  beforeEach(() => { capture = collectPermissionEvents(); });
  afterEach(() => { capture.restore(); });
  return () => capture.events;
}

export async function captureInvocationCorrelations() {
  const runner = await import("../../tools/invocation-runner.js");
  const run = runner.runToolInvocation;
  const correlations = new Map<string, string>();
  const spy = vi.spyOn(runner, "runToolInvocation").mockImplementation((...args) => {
    const [services, toolUse] = args;
    correlations.set(toolUse.id, services.invocationTerminal.correlationId);
    return run(...args);
  });
  return {
    get: (toolUseId: string) => correlations.get(toolUseId) ?? null,
    restore: () => spy.mockRestore(),
  };
}

export function trackInvocationCorrelations() {
  let capture: Awaited<ReturnType<typeof captureInvocationCorrelations>> | undefined;
  beforeEach(async () => {
    capture = await captureInvocationCorrelations();
  });
  afterEach(() => {
    capture?.restore();
    capture = undefined;
  });
  return (toolUseId: string) => capture?.get(toolUseId) ?? null;
}
