// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { EgressDenialsList } from "../permissions/EgressDenialsList.js";
import type { EgressDenialRow } from "../../../../shared/egress-denials.js";

function row(overrides: Partial<EgressDenialRow> = {}): EgressDenialRow {
  return {
    timestamp: "2026-10-19T03:00:00.000Z",
    source: { kind: "shell", toolName: "bash", toolUseId: "toolu_01FIXTURE" },
    deny: { action: "network-outbound", host: "example.com", port: 443, method: null, url: null, reason: "domain not allowed" },
    ...overrides,
  };
}

describe("EgressDenialsList", () => {
  let previousLocale: ReturnType<typeof getLocale>;
  beforeEach(() => { previousLocale = getLocale(); setLocale("en"); });
  afterEach(() => { setLocale(previousLocale); });

  it("lists each refused host with the invocation that opened it", async () => {
    const fetcher = vi.fn(async () => [
      row(),
      row({ source: { kind: "terminal", tabId: "terminal:0000000a-1" }, deny: { ...row().deny, host: "github.com", port: 22 } }),
      row({ source: { kind: "worker", role: "worker", pluginId: "acme_notes", instanceId: "indexer" }, deny: { ...row().deny, host: "tracker.example" } }),
      row({ source: { kind: "unattributed" }, deny: { ...row().deny, host: "odd.example" } }),
      row({ deny: { action: "http-request", host: "hooks.example.com", port: null, method: "POST", url: "https://hooks.example.com/upload/[REDACTED]", reason: "filtered" } }),
    ]);
    render(<EgressDenialsList fetcher={fetcher} />);
    await waitFor(() => expect(screen.getAllByTestId("egress-denial-row")).toHaveLength(5));
    const text = screen.getByTestId("egress-denials").textContent ?? "";
    expect(text).toContain("example.com:443");
    expect(text).toContain("Bash tool call toolu_01FIXTURE");
    expect(text).toContain("domain not allowed");
    expect(text).toContain("github.com:22");
    expect(text).toContain("Terminal tab terminal:0000000a-1");
    expect(text).toContain("Plugin acme_notes, worker indexer");
    expect(text).toContain("Unattributed");
    expect(text).toContain("POST https://hooks.example.com/upload/[REDACTED]");
  });

  it("says when nothing was refused, and re-reads on refresh", async () => {
    const fetcher = vi.fn(async () => [] as EgressDenialRow[]);
    render(<EgressDenialsList fetcher={fetcher} />);
    await screen.findByTestId("egress-denials-empty");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("shows an IPC refusal instead of an empty list", async () => {
    render(<EgressDenialsList fetcher={async () => ({ ok: false, error: "UNAUTHORIZED_FRAME" })} />);
    expect((await screen.findByTestId("egress-denials-error")).textContent).toContain("UNAUTHORIZED_FRAME");
  });
});
