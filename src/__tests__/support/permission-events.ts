import { vi } from "vitest";

export function watchPermissionEvents(
  onEvent: (event: Record<string, unknown> & { event: string }) => void,
) {
  return vi.spyOn(console, "log").mockImplementation((message, data) => {
    if (typeof message === "string" && message.startsWith("[permissions] ")
      && data && typeof data.event === "string") {
      onEvent(data);
    }
  });
}
