import { collectPermissionEvents } from "../../__tests__/support/permission-events.js";
import { describe, it, expect, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import {
  validateSender,
  validateHostRendererSender,
  UNAUTHORIZED_FRAME,
  auditUnauthorized,
} from "../gated.js";
import { foreignFrameEvent } from "../../__tests__/test-helpers.js";

describe("validateSender", () => {
  it("accepts file:// renderer", () => {
    expect(validateSender(foreignFrameEvent("file:///Applications/Ave.app/dist/index.html"))).toBe(true);
  });

  it("accepts http://localhost (dev server)", () => {
    expect(validateSender(foreignFrameEvent("http://localhost:5173/"))).toBe(true);
  });

  it("accepts http://127.0.0.1 (dev server)", () => {
    expect(validateSender(foreignFrameEvent("http://127.0.0.1:5173/"))).toBe(true);
  });

  // Parse origins exactly; prefix matching admits attacker-controlled hostnames.
  it("rejects attacker host that starts with 'localhost'", () => {
    expect(validateSender(foreignFrameEvent("http://localhost.attacker.com/"))).toBe(false);
    expect(validateSender(foreignFrameEvent("https://localhost.attacker.com/"))).toBe(false);
  });

  it("rejects https://localhost (non-http scheme not in allowlist)", () => {
    expect(validateSender(foreignFrameEvent("https://localhost/"))).toBe(false);
  });

  it("rejects arbitrary remote origin", () => {
    expect(validateSender(foreignFrameEvent("https://evil.example.com/"))).toBe(false);
  });

  it("rejects malformed URL", () => {
    expect(validateSender(foreignFrameEvent("not-a-url"))).toBe(false);
  });

  // A destroyed or navigated frame loses senderFrame; absence must fail closed.
  it("refuses a missing senderFrame", () => {
    expect(validateSender(null)).toBe(false);
    expect(validateSender(undefined)).toBe(false);
    expect(validateSender({} as IpcMainInvokeEvent)).toBe(false);
    expect(validateSender({ senderFrame: null } as unknown as IpcMainInvokeEvent)).toBe(false);
  });

  it("refuses a present frame with an empty url", () => {
    expect(validateSender(foreignFrameEvent(""))).toBe(false);
  });
});

describe("validateHostRendererSender", () => {
  it("accepts the host file renderer", () => {
    expect(validateHostRendererSender(foreignFrameEvent("file:///Applications/Ave.app/dist/index.html"))).toBe(true);
  });

  it("accepts dev server host renderer URLs", () => {
    expect(validateHostRendererSender(foreignFrameEvent("http://localhost:5173/"))).toBe(true);
    expect(validateHostRendererSender(foreignFrameEvent("http://127.0.0.1:5173/"))).toBe(true);
  });

  it("rejects isolated app-resource frames", () => {
    expect(validateHostRendererSender(foreignFrameEvent("ave-mcp-app://s-66697874757265/proxy.html?t=fixture"))).toBe(false);
  });

  it("rejects arbitrary remote origins", () => {
    expect(validateHostRendererSender(foreignFrameEvent("https://evil.example.com/"))).toBe(false);
  });

  it("rejects missing senderFrame for state-mutating host channels", () => {
    expect(validateHostRendererSender(null)).toBe(false);
    expect(validateHostRendererSender(undefined)).toBe(false);
    expect(validateHostRendererSender({} as IpcMainInvokeEvent)).toBe(false);
  });
});

describe("UNAUTHORIZED_FRAME", () => {
  it("has ok=false and error='unauthorized-frame'", () => {
    expect(UNAUTHORIZED_FRAME).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("sender refusal logging", () => {
  it("emits exactly the channel and event for a denied sender", () => {
    const capture = collectPermissionEvents();
    try {
      auditUnauthorized("ave:test:channel");
      expect(capture.events).toEqual([{ event: "ipc_sender_refused", channel: "ave:test:channel" }]);
    } finally {
      capture.restore();
    }
  });
});

describe("gated() integration — unauthorized path returns UNAUTHORIZED_FRAME", () => {
  it("handler is NOT called when sender is unauthorized", async () => {
    const handler = vi.fn(async (_event: IpcMainInvokeEvent) => ({ ok: true }));
    const event = foreignFrameEvent("https://evil.example.com/") as IpcMainInvokeEvent;

    const result = !validateSender(event) ? UNAUTHORIZED_FRAME : await handler(event);

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual(UNAUTHORIZED_FRAME);
  });

  it("handler IS called when sender is authorized", async () => {
    const handler = vi.fn(async (_event: IpcMainInvokeEvent) => ({ ok: true, data: "hello" }));
    const event = foreignFrameEvent("file:///dist/index.html") as IpcMainInvokeEvent;

    const result = !validateSender(event) ? UNAUTHORIZED_FRAME : await handler(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, data: "hello" });
  });
});
