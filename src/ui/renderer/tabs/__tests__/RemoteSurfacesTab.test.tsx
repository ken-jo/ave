/** Every connection has one row; deep links must expand collapsed rows before locating their anchors. */
// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceInstalledMessagingConnection } from "../../../../shared/marketplace-package-assets.js";
import type { AveApi } from "../../types.js";
import { RemoteSurfacesTab } from "../RemoteSurfacesTab.js";

// The local-API gates read the window-scoped client rather than the `api` this tab threads down, so the row that opens
// onto them needs it stood up too.
vi.mock("../../api-client.js", () => ({
  getApi: () => ({
    getSettings: async () => ({ system: {}, features: {} }),
    updateSettings: async () => ({}),
    envForcedSettings: async () => [],
    remoteA2a: { status: async () => ({ ok: false, error: "a2a-remote-disabled" }) },
  }),
}));

const TELEGRAM: MarketplaceInstalledMessagingConnection = {
  connectionId: "telegram",
  label: "Telegram",
  summary: "Reach one Ave conversation from Telegram.",
  pairing: "one-time-code",
  credentials: [{ key: "botToken", label: "Bot token", secret: true }],
  egress: ["api.telegram.org"],
  docsUrl: "https://core.telegram.org/bots/api",
};

const OBSERVER_CONFIG = {
  enabled: false,
  authorization: { kind: "tailnet-identity" as const },
  port: 46_173,
  controllerEnabled: false,
  pairedSharingEnabled: false,
  webEnabled: false,
  webOrigin: "",
};

const UNSET = {
  enabled: "unset" as const,
  authorization: "unset" as const,
  port: "unset" as const,
  controllerEnabled: "unset" as const,
  pairedSharingEnabled: "unset" as const,
  webEnabled: "unset" as const,
  webOrigin: "unset" as const,
};

const DNS_NAME = "desk.example-tailnet.ts.net";

function observerSnapshot() {
  return {
    saved: OBSERVER_CONFIG,
    effective: OBSERVER_CONFIG,
    provenance: UNSET,
    listeningPort: null,
    lastStartError: null,
    pairedSharingBootstrapFailed: false,
    ownDeviceAdmission: false,
    environment: {
      state: "ready" as const,
      login: "owner@example.com",
      dnsName: DNS_NAME,
      tailnetName: "example-tailnet.ts.net",
      serveConfigured: false,
      serveTargetPort: null,
      detail: null,
    },
    derivedWebOrigin: `https://${DNS_NAME}`,
    serveCommand: null,
    configFileError: null,
  };
}

function makeApi(options: {
  telegramState?: string;
  resumeFails?: boolean;
  /** What `marketplace.installedMessagingConnections` holds. Null is what a desktop that never installed one actually stores. */
  installed?: readonly MarketplaceInstalledMessagingConnection[] | null;
} = {}) {
  const resume = vi.fn(async () => (options.resumeFails === true
    ? { ok: false as const, error: "telegram-connection-unavailable" as const }
    : { ok: true as const }));
  const api = {
    getSettings: vi.fn(async () => ({
      marketplace: {
        installedMessagingConnections: options.installed === undefined
          ? [TELEGRAM]
          : options.installed,
      },
      system: {},
      features: {},
    })),
    updateSettings: vi.fn(async () => ({ ok: true })),
    openExternalUrl: vi.fn(async () => undefined),
    remoteA2a: {
      status: vi.fn(async () => ({ ok: false as const, error: "a2a-remote-disabled" })),
    },
    tailnetObserver: {
      snapshot: vi.fn(async () => ({ ok: true as const, snapshot: observerSnapshot() })),
      apply: vi.fn(async () => ({ ok: true as const })),
      configureServe: vi.fn(async () => ({ ok: true as const, url: `https://${DNS_NAME}/` })),
      guidedSetup: vi.fn(async () => ({
        ok: true as const,
        snapshot: observerSnapshot(),
        webOrigin: `https://${DNS_NAME}`,
        port: 46_173,
        serve: "configured" as const,
      })),
      setOwnDeviceAdmission: vi.fn(async () => ({ ok: true as const })),
    },
    tailnetSharing: {
      snapshot: vi.fn(async () => ({
        ok: true as const,
        snapshot: { invitations: [], pairings: [], shares: [] },
      })),
      createInvitation: vi.fn(async () => ({ ok: false as const, error: "unauthorized" as const })),
      activatePairing: vi.fn(async () => ({ ok: true as const })),
      createCurrentConversationShare: vi.fn(async () => ({ ok: true as const })),
      revokeShare: vi.fn(async () => ({ ok: true as const })),
      revokePairing: vi.fn(async () => ({ ok: true as const })),
      onChanged: vi.fn(() => () => undefined),
    },
    telegramConnection: {
      snapshot: vi.fn(async () => ({
        ok: true as const,
        snapshot: {
          state: options.telegramState ?? "disconnected",
          botUsername: null,
          pairing: null,
          approval: null,
          pendingCode: null,
          lastErrorCode: null,
        },
      })),
      resume,
      pause: vi.fn(async () => ({ ok: true as const })),
      disconnect: vi.fn(async () => ({ ok: true as const })),
      onChanged: vi.fn(() => () => undefined),
    },
  } as unknown as AveApi;
  return { api, resume };
}

describe("RemoteSurfacesTab", () => {
  it("puts every connection vendor on the page as exactly one row", async () => {
    const { api } = makeApi();
    const { container } = render(<RemoteSurfacesTab api={api} />);

    await screen.findByTestId("connection:telegram");
    const rows = [...container.querySelectorAll("[data-connection-row]")]
      .map((row) => row.getAttribute("data-connection-row"));
    expect(rows).toEqual([
      "connection:tailnet",
      "connection:telegram",
      "connection:local-api",
    ]);
  });

  it("keeps Telegram a row on a desktop that installed no messaging connection", async () => {
    // What a desktop that never installed one actually stores. Telegram is built into this build, so its row cannot depend on
    // that list.
    const { api } = makeApi({ installed: null });
    const { container } = render(<RemoteSurfacesTab api={api} />);

    await screen.findByTestId("connection:telegram");
    expect([...container.querySelectorAll("[data-connection-row]")]
      .map((row) => row.getAttribute("data-connection-row")))
      .toEqual(["connection:tailnet", "connection:telegram", "connection:local-api"]);

    fireEvent.click(screen.getByTestId("connection:telegram:toggle"));
    expect(await screen.findByTestId("telegram-connection-content")).toBeTruthy();
  });

  it("keeps every row's detail folded away until it is opened", async () => {
    const { api } = makeApi();
    render(<RemoteSurfacesTab api={api} />);

    await screen.findByTestId("connection:telegram");
    expect(screen.queryByTestId("connection:tailnet:detail")).toBeNull();
    expect(screen.queryByTestId("connection:local-api:detail")).toBeNull();
    expect(screen.queryByTestId("connection:telegram:detail")).toBeNull();
  });

  it("opens a row onto the controls that vendor already had", async () => {
    const { api } = makeApi();
    render(<RemoteSurfacesTab api={api} />);

    fireEvent.click(await screen.findByTestId("connection:local-api:toggle"));
    expect(await screen.findByTestId("local-api-surfaces-local-api")).toBeTruthy();
    expect(screen.getByTestId("local-api-surfaces-a2a-remote-receiver")).toBeTruthy();

    // Rows open independently — setting two connections up side by side is a real thing to want, so opening the next one must
    // not close the last.
    fireEvent.click(screen.getByTestId("connection:tailnet:toggle"));
    expect(await screen.findByTestId("tailnet-access-content")).toBeTruthy();
    expect(screen.getByTestId("local-api-surfaces-local-api")).toBeTruthy();

    // And the head closes it again.
    fireEvent.click(screen.getByTestId("connection:local-api:toggle"));
    expect(screen.queryByTestId("local-api-surfaces-local-api")).toBeNull();
  });

  it("folds a row away when the action it was opened for succeeds", async () => {
    const { api } = makeApi({ telegramState: "paused-by-owner" });
    render(<RemoteSurfacesTab api={api} />);

    fireEvent.click(await screen.findByTestId("connection:telegram:toggle"));
    fireEvent.click(await screen.findByTestId("telegram-connection-resume"));

    await waitFor(() => {
      expect(screen.queryByTestId("connection:telegram:detail")).toBeNull();
    });
  });

  it("keeps the row open, with its error, when that action fails", async () => {
    const { api } = makeApi({ telegramState: "paused-by-owner", resumeFails: true });
    render(<RemoteSurfacesTab api={api} />);

    fireEvent.click(await screen.findByTestId("connection:telegram:toggle"));
    fireEvent.click(await screen.findByTestId("telegram-connection-resume"));

    expect(await screen.findByTestId("telegram-connection-feedback")).toBeTruthy();
    expect(screen.getByTestId("connection:telegram:detail")).toBeTruthy();
  });

  // Folded rows keep their anchors out of the DOM, so arrival must expand the owning row first.
  function sectionArrivalCase(sectionTarget: string) {
    return async () => {
      const { api } = makeApi();
      const { container } = render(
        <RemoteSurfacesTab api={api} sectionTarget={sectionTarget} />,
      );

      await waitFor(() => {
        expect(container.querySelector(`[data-settings-section='${sectionTarget}']`))
          .not.toBeNull();
      });
    };
  }

  it("opens the row that holds the section a deep link named", sectionArrivalCase("remote-tailnet-observer"));
  it("opens the messaging row a deep link into that connection named", sectionArrivalCase("remote-telegram"));

  it("keeps the messaging group anchor reachable with every row folded", async () => {
    const { api } = makeApi();
    const { container } = render(<RemoteSurfacesTab api={api} />);

    await screen.findByTestId("connection:telegram");
    expect(container.querySelector("[data-settings-section='remote-messaging-connections']"))
      .not.toBeNull();
    expect(screen.queryByTestId("connection:telegram:detail")).toBeNull();
  });

  it("reads a listener that was never set up as setup-needed", async () => {
    const { api } = makeApi();
    render(<RemoteSurfacesTab api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("connection:tailnet:state").textContent).toBe("설정 필요");
    });
    expect(screen.getByTestId("connection:tailnet:endpoint").textContent)
      .toBe(`https://${DNS_NAME}`);
  });

  describe("the folded Tailnet line", () => {
    const LISTENING = {
      effective: { ...OBSERVER_CONFIG, enabled: true },
      listeningPort: 46_173,
    };

    async function rowStateFor(snapshot: Record<string, unknown> | "rejected" | "unavailable") {
      const { api } = makeApi();
      const read = vi.mocked(api.tailnetObserver.snapshot);
      if (snapshot === "rejected") read.mockRejectedValue(new Error("ipc closed"));
      else if (snapshot === "unavailable") {
        read.mockResolvedValue({ ok: false, error: "tailnet-observer-unavailable" } as never);
      } else read.mockResolvedValue({ ok: true, snapshot: { ...observerSnapshot(), ...snapshot } } as never);
      const view = render(<RemoteSurfacesTab api={api} />);
      let text = "";
      await waitFor(() => {
        text = screen.getByTestId("connection:tailnet:state").textContent ?? "";
        expect(text).not.toBe("");
      });
      view.unmount();
      return text;
    }

    it("reads connected only once the listener is up and behind Serve", async () => {
      expect(await rowStateFor({
        ...LISTENING,
        environment: { ...observerSnapshot().environment, serveConfigured: true, serveTargetPort: 46_173 },
      })).toBe("연결됨");
      // Listening but not fronted by Serve: reachable from this desktop only.
      expect(await rowStateFor(LISTENING)).toBe("설정 필요");
      expect(await rowStateFor({
        ...LISTENING,
        environment: { ...observerSnapshot().environment, serveConfigured: true, serveTargetPort: 9_999 },
      })).toBe("설정 필요");
    });

    it("reads every failure the open section reports as needing attention", async () => {
      expect(await rowStateFor({ effective: { ...OBSERVER_CONFIG, enabled: true }, lastStartError: "tailnet-observer-port-in-use" }))
        .toBe("확인 필요");
      expect(await rowStateFor({ configFileError: "tailnet-observer-config-unreadable" })).toBe("확인 필요");
      expect(await rowStateFor({ pairedSharingBootstrapFailed: true })).toBe("확인 필요");
      expect(await rowStateFor({
        ...LISTENING,
        environment: { ...observerSnapshot().environment, state: "cli-failed", detail: "tailscaled not running" },
      })).toBe("확인 필요");
    });

    it("reads a status read that failed or threw as needing attention", async () => {
      expect(await rowStateFor("unavailable")).toBe("확인 필요");
      expect(await rowStateFor("rejected")).toBe("확인 필요");
    });
  });

  it("does not claim a local-API count it could not read", async () => {
    const { api } = makeApi();
    vi.mocked(api.getSettings).mockRejectedValue(new Error("ipc closed"));
    render(<RemoteSurfacesTab api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("connection:local-api:state").textContent).toBe("확인 필요");
    });
    expect(screen.queryByTestId("connection:local-api:endpoint")?.textContent ?? "").not.toContain("0");
    // The Tailnet row is read independently and still answers.
    expect(screen.getByTestId("connection:tailnet:state").textContent).toBe("설정 필요");
  });

  it("counts the local-API opt-ins on its own line rather than hiding them", async () => {
    const { api } = makeApi();
    render(<RemoteSurfacesTab api={api} />);

    await waitFor(() => {
      // Off, not "setup needed": four switches all down is a resting state.
      expect(screen.getByTestId("connection:local-api:state").textContent).toBe("꺼짐");
    });
    expect(screen.getByTestId("connection:local-api:endpoint").textContent)
      .toBe("127.0.0.1 · 4개 중 0개 켜짐");
  });

  describe("the local-API row reads the remote A2A runtime, not only its switch", () => {
    async function localApiRowFor(status: "start-failed" | "disabled" | "rejected" | "restart-pending") {
      const { api } = makeApi();
      vi.mocked(api.getSettings).mockResolvedValue({
        marketplace: { installedMessagingConnections: [TELEGRAM] },
        system: {},
        features: { a2aRemoteRouting: true },
      } as never);
      const read = vi.mocked(api.remoteA2a.status);
      if (status === "rejected") read.mockRejectedValue(new Error("ipc closed"));
      else if (status === "restart-pending") {
        read.mockResolvedValue({ ok: false, error: "a2a-remote-disabled", restartPending: true });
      }
      else if (status === "start-failed") {
        read.mockResolvedValue({ ok: false, error: "a2a-remote-start-failed", reason: "a2a-remote-outbound-config-incomplete" });
      }
      const view = render(<RemoteSurfacesTab api={api} />);
      let text = "";
      await waitFor(() => {
        text = screen.getByTestId("connection:local-api:state").textContent ?? "";
        expect(text).not.toBe("");
      });
      view.unmount();
      return text;
    }

    it("reads a switched-on gate whose runtime did not start as needing attention", async () => {
      expect(await localApiRowFor("start-failed")).toBe("확인 필요");
    });

    it("reads a switch flipped since launch as pending a restart, not connected", async () => {
      expect(await localApiRowFor("restart-pending")).toBe("대기 중");
    });

    it("keeps reading a switched-on gate as connected when nothing failed to start", async () => {
      expect(await localApiRowFor("disabled")).toBe("연결됨");
      // A status read that itself failed claims nothing either way.
      expect(await localApiRowFor("rejected")).toBe("연결됨");
    });
  });
});
