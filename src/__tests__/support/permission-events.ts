import { vi } from "vitest";

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
