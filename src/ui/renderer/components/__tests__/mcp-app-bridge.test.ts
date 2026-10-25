import { describe, it, expect, vi, beforeEach } from "vitest";

// Record capabilities and handlers at connect time; hoist the fixture because mock factories run before local
// declarations.
const { FakeAppBridge } = vi.hoisted(() => {
  class FakeAppBridge {
    capabilities: Record<string, unknown>;
    hostContext: unknown;
    onsandboxready?: unknown;
    onreadresource?: unknown;
    oncalltool?: unknown;
    onmessage?: unknown;
    ondownloadfile?: unknown;
    onupdatemodelcontext?: unknown;
    onopenlink?: unknown;
    onsizechange?: unknown;
    onrequestdisplaymode?: unknown;
    connectCalled = false;
    handlersAtConnect: Record<string, boolean> = {};

    constructor(
      _client: unknown,
      _hostInfo: unknown,
      capabilities: Record<string, unknown>,
      options: { hostContext?: unknown },
    ) {
      this.capabilities = capabilities;
      this.hostContext = options?.hostContext;
    }

    sendSandboxResourceReady(): void {}

    connect(_transport: unknown): Promise<void> {
      this.connectCalled = true;
      this.handlersAtConnect = {
        onsandboxready: typeof this.onsandboxready === "function",
        onreadresource: typeof this.onreadresource === "function",
        oncalltool: typeof this.oncalltool === "function",
        onmessage: typeof this.onmessage === "function",
        ondownloadfile: typeof this.ondownloadfile === "function",
        onupdatemodelcontext: typeof this.onupdatemodelcontext === "function",
        onopenlink: typeof this.onopenlink === "function",
        onsizechange: typeof this.onsizechange === "function",
        onrequestdisplaymode: typeof this.onrequestdisplaymode === "function",
      };
      return Promise.resolve();
    }
  }
  return { FakeAppBridge };
});

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({ AppBridge: FakeAppBridge }));

import { createMcpAppBridge } from "../mcp-app-bridge.js";

type FakeBridge = InstanceType<typeof FakeAppBridge>;

const fakeEl = { send: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };

function build() {
  return createMcpAppBridge(
    { serverId: "s1" },
    "<html><body>card</body></html>",
    fakeEl as never,
    {},
    {
      onResize: vi.fn(),
      openLink: vi.fn(async () => ({ ok: true })),
      callTool: vi.fn(async () => ({ ok: true as const, result: "ok" })),
      postMessage: vi.fn(async () => ({ ok: true as const, disposition: "queued" as const })),
      getDisplayMode: vi.fn(() => "inline" as const),
      applyDisplayMode: vi.fn(async () => "inline" as const),
      downloadFile: vi.fn(async () => ({ ok: true as const, disposition: "saved" as const })),
      updateModelContext: vi.fn(async () => ({ ok: true as const, disposition: "stored" as const })),
    },
  );
}

beforeEach(() => {
  fakeEl.send.mockClear();
});

describe("createMcpAppBridge — capabilities are derived from the single active-handler set", () => {
  it("advertises exactly the capabilities whose handlers are wired, nothing else", () => {
    const { bridge } = build();
    // Advertise only wired capabilities; display modes use host-context availableDisplayModes, not a capability key.
    expect((bridge as unknown as FakeBridge).capabilities).toEqual({
      serverResources: {},
      serverTools: {},
      message: { text: {} },
      updateModelContext: { text: {}, structuredContent: {} },
      downloadFile: {},
      openLinks: {},
    });
  });
});

describe("createMcpAppBridge — every handler registers before connect()", () => {
  it("has every handler present at the moment connect() is called", () => {
    const { bridge } = build();
    const fake = bridge as unknown as FakeBridge;

    expect(fake.connectCalled).toBe(true);
    expect(fake.handlersAtConnect).toEqual({
      onsandboxready: true,
      onreadresource: true,
      oncalltool: true,
      onmessage: true,
      ondownloadfile: true,
      onupdatemodelcontext: true,
      onopenlink: true,
      onsizechange: true,
      onrequestdisplaymode: true,
    });
  });

  it("returns a bridge with each handler wired as a function", () => {
    const { bridge } = build();
    const fake = bridge as unknown as FakeBridge;
    expect(typeof fake.onsandboxready).toBe("function");
    expect(typeof fake.onreadresource).toBe("function");
    expect(typeof fake.oncalltool).toBe("function");
    expect(typeof fake.onmessage).toBe("function");
    expect(typeof fake.ondownloadfile).toBe("function");
    expect(typeof fake.onupdatemodelcontext).toBe("function");
    expect(typeof fake.onopenlink).toBe("function");
    expect(typeof fake.onsizechange).toBe("function");
    expect(typeof fake.onrequestdisplaymode).toBe("function");
  });
});
