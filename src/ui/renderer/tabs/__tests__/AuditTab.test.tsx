/** Pin TZ to expose local/UTC day differences; fake only Date so waitFor keeps real timers. */
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { installMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { formatMediumDateTime } from "../../../../shared/format-time.js";
import type { AuditEntry } from "../../../../audit/audit-logger.js";

vi.mock("../DiagnosticsSection.js", () => ({ DiagnosticsSection: () => null }));
vi.mock("../TelemetrySection.js", () => ({ TelemetrySection: () => null }));

import { AuditTab } from "../AuditTab.js";

/** 01:30 on the 16th in Seoul, 12:30 on the 15th in New York, 16:30 on the 15th in UTC. */
const SEOUL_SMALL_HOURS = Date.parse("2026-06-15T16:30:00.000Z");
/** 21:00 on the 15th in New York (EDT), already the 16th in UTC. */
const NEW_YORK_EVENING = Date.parse("2026-06-16T01:00:00.000Z");

let previousTz: string | undefined;

beforeEach(() => {
  previousTz = process.env.TZ;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

function installAuditApi(entries: AuditEntry[] = []) {
  const api = installMockAveApi();
  const search = vi.fn(async (_filter: unknown) => ({ entries, total: entries.length }));
  const getStats = vi.fn(async () => ({ totalByType: {}, totalByDay: {}, sensitiveOps: 0 }));
  (api as Record<string, unknown>).audit = { search, getStats };
  return { search };
}

function renderAt(zone: string, now: number) {
  process.env.TZ = zone;
  vi.useFakeTimers({ toFake: ["Date"], now });
  const view = render(<AuditTab />);
  return {
    ...view,
    from: view.getByTestId("audit-date-from") as HTMLInputElement,
    to: view.getByTestId("audit-date-to") as HTMLInputElement,
  };
}

describe("AuditTab date picker", () => {
  it("seeds the picker with the host-local day on a Seoul host in the small hours", async () => {
    const { search } = installAuditApi();
    const { from, to } = renderAt("Asia/Seoul", SEOUL_SMALL_HOURS);
    expect(to.value).toBe("2026-06-16");
    expect(from.value).toBe("2026-06-09");
    await waitFor(() => expect(search).toHaveBeenCalled());
    expect(search.mock.calls[0][0]).toMatchObject({ dateFrom: "2026-06-09", dateTo: "2026-06-16" });
  });

  it("keeps a New York evening on its local day after UTC has rolled over", () => {
    installAuditApi();
    const { from, to } = renderAt("America/New_York", NEW_YORK_EVENING);
    expect(to.value).toBe("2026-06-15");
    expect(from.value).toBe("2026-06-08");
  });

  it("control: under UTC the seed is the UTC day", () => {
    installAuditApi();
    const { to } = renderAt("UTC", SEOUL_SMALL_HOURS);
    expect(to.value).toBe("2026-06-15");
  });
});

describe("AuditTab row timestamps", () => {
  it("renders each row's instant in the host zone rather than as the stored UTC string", async () => {
    const timestamp = "2026-06-15T16:30:00.000Z";
    installAuditApi([
      { timestamp, sessionId: "session-1", type: "turn", input: "hello", output: "world" },
    ]);
    process.env.TZ = "UTC";
    const utcLabel = formatMediumDateTime(timestamp);
    const { findByTestId } = renderAt("Asia/Seoul", SEOUL_SMALL_HOURS);
    const seoulLabel = formatMediumDateTime(timestamp);
    expect(seoulLabel).not.toBe(utcLabel);
    const cell = await findByTestId("audit-row-time");
    expect(cell.textContent).toBe(seoulLabel);
    expect(cell.textContent).not.toContain("2026-06-15T16:30");
  });
});

describe("AuditTab submitted filters", () => {
  it("pages using the submitted filter rather than unsaved edits", async () => {
    const { search } = installAuditApi();
    search.mockResolvedValue({ entries: [], total: 120 });
    const view = render(<AuditTab />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const original = search.mock.calls[0][0] as { dateFrom: string };
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(view.getByTestId("audit-date-from"), { target: { value: "2020-01-01" } });
    fireEvent.click(await view.findByRole("button", { name: (await import("../../../../i18n/runtime.js")).t("auditTab.nextPage") }));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(search.mock.calls[1][0]).toMatchObject({ dateFrom: original.dateFrom, offset: 50 });
  });

  it("refuses a reversed date range before IPC and gives a localized error", async () => {
    const { search } = installAuditApi();
    const view = render(<AuditTab />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(view.getByTestId("audit-date-from"), { target: { value: "2027-01-01" } });
    fireEvent.change(view.getByTestId("audit-date-to"), { target: { value: "2026-01-01" } });
    const { t } = await import("../../../../i18n/runtime.js");
    fireEvent.click(view.getByRole("button", { name: t("auditTab.searchButton") }));
    expect(await view.findByRole("alert")).toHaveTextContent(t("auditTab.invalidDateRange"));
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("clears old results when the submitted search fails", async () => {
    const { search } = installAuditApi([{ timestamp: new Date().toISOString(), sessionId: "test", type: "turn", input: "previous data" }]);
    const view = render(<AuditTab />);
    await view.findByText("previous data");
    search.mockRejectedValueOnce(new Error("raw internal error"));
    const { fireEvent } = await import("@testing-library/react");
    const { t } = await import("../../../../i18n/runtime.js");
    fireEvent.click(view.getByRole("button", { name: t("auditTab.searchButton") }));
    expect(await view.findByRole("alert")).toHaveTextContent(t("auditTab.searchFailed"));
    expect(view.queryByText("previous data")).toBeNull();
    expect(view.queryByText("raw internal error")).toBeNull();
  });
});

describe("AuditTab accessible controls", () => {
  it("labels date, type and text filters and exposes row details as an expandable button", async () => {
    installAuditApi([{ timestamp: new Date().toISOString(), sessionId: "session-1", type: "turn", input: "keyboard entry" }]);
    const view = render(<AuditTab />);
    const { t } = await import("../../../../i18n/runtime.js");
    expect(view.getByLabelText(t("auditTab.filterDateFrom"))).toBe(view.getByTestId("audit-date-from"));
    expect(view.getByLabelText(t("auditTab.filterDateTo"))).toBe(view.getByTestId("audit-date-to"));
    expect(view.getByRole("combobox", { name: t("auditTab.filterType") })).toBeVisible();
    expect(view.getByRole("textbox", { name: t("auditTab.filterTextPlaceholder") })).toBeVisible();
    const toggle = await view.findByRole("button", { name: t("auditTab.toggleDetails", { number: 1 }) });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const detailsId = toggle.getAttribute("aria-controls");
    expect(detailsId).toBeTruthy();
    if (!detailsId) throw new Error("Audit details control target is missing.");
    expect(document.getElementById(detailsId)).toHaveTextContent('"keyboard entry"');
  });
});
