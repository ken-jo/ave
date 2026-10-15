/**
 * The browser page actions and the snapshot ref table, over a fake CDP
 * session: ref minting and stability, re-render following, stale refs,
 * the snapshot cap, sensitive-field refusal, cancellation, and the
 * cross-origin redirect guard of navigate.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  BrowserActionError,
  click,
  navigate,
  pressKey,
  resolveRef,
  screenshot,
  sensitiveFieldReason,
  settle,
  snapshot,
  type ActionTarget,
  type CdpSession,
  type NavigableGuest,
} from "../browser-actions.js";
import { BrowserRefTable, SNAPSHOT_MAX_CHARS, type AXNode } from "../browser-snapshot.js";
import { type as typeInto } from "../browser-actions.js";
import { browserOrigin } from "../../../tools/browser-tools.js";

function ax(nodeId: string, role: string, name: string, extra: Partial<AXNode> = {}): AXNode {
  return { nodeId, role: { type: "role", value: role }, name: { type: "computedString", value: name }, ...extra };
}

/** A page: a root with the given children (each a leaf). */
function page(children: AXNode[]): AXNode[] {
  return [
    ax("root", "RootWebArea", "Fixture", { childIds: children.map((child) => child.nodeId) }),
    ...children.map((child) => ({ ...child, parentId: "root" })),
  ];
}

class FakeCdp implements CdpSession {
  nodes: AXNode[] = [];
  attributes = new Map<number, Record<string, string>>();
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  /** A mouse press gives the page focus after this many focus checks (Infinity: never). */
  focusLag = 0;
  /** Text inserts lost (focus moved away) before one lands. */
  dropTexts = 0;
  private focusedNode: number | undefined;
  private pressed = false;
  loseFocus(): void {
    this.pressed = false;
    this.checksSincePress = 0;
  }
  private checksSincePress = 0;
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, ...(params ? { params } : {}) });
    switch (method) {
      case "Input.dispatchMouseEvent":
        if (params?.type === "mousePressed") this.pressed = true;
        return {};
      case "DOM.focus":
        this.focusedNode = params?.backendNodeId as number;
        return {};
      case "Input.insertText": {
        if (this.dropTexts > 0) {
          this.dropTexts--;
          return {};
        }
        this.nodes = this.nodes.map((node) => node.backendDOMNodeId === this.focusedNode
          ? { ...node, value: { type: "string", value: params?.text } }
          : node);
        return {};
      }
      case "Accessibility.getFullAXTree": {
        if (!this.pressed || this.checksSincePress++ < this.focusLag) return { nodes: this.nodes };
        const [root, ...rest] = this.nodes;
        return { nodes: root ? [{ ...root, properties: [{ name: "focused", value: { type: "booleanOrUndefined", value: true } }] }, ...rest] : [] };
      }
      case "Accessibility.getPartialAXTree": {
        const node = this.nodes.find((candidate) => candidate.backendDOMNodeId === params?.backendNodeId);
        if (!node) throw new Error("No node with given id found");
        return { nodes: [node] };
      }
      case "DOM.getContentQuads":
        return { quads: [[10, 10, 30, 10, 30, 20, 10, 20]] };
      case "DOM.describeNode": {
        const attributes = this.attributes.get(params?.backendNodeId as number) ?? {};
        return { node: { attributes: Object.entries(attributes).flat() } };
      }
      default:
        return {};
    }
  }
  inputs(): string[] {
    return this.calls.filter((call) => call.method.startsWith("Input.")).map((call) => call.method);
  }
}

function target(cdp: FakeCdp, options: { tabId?: string; url?: string; signal?: AbortSignal } = {}) {
  let url = options.url ?? "https://a.example/form";
  const injected: number[] = [];
  const released: number[] = [];
  const value: ActionTarget & { setUrl(next: string): void; injected: number[]; released: number[] } = {
    tabId: options.tabId ?? "tab-1",
    url: () => url,
    title: () => "Fixture",
    cdp,
    injectInput: async (inject) => {
      injected.push(cdp.calls.length);
      return inject();
    },
    releaseFocus: () => {
      released.push(cdp.calls.length);
      cdp.loseFocus();
    },
    released,
    signal: options.signal ?? new AbortController().signal,
    setUrl: (next) => {
      url = next;
    },
    injected,
  };
  return value;
}

describe("browser snapshot refs", () => {
  it("gives interactive elements refs that stay the same across snapshots", async () => {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page([
      ax("h", "heading", "Sign up", { backendDOMNodeId: 1, properties: [{ name: "level", value: { value: 1 } }] }),
      ax("n", "textbox", "Name", { backendDOMNodeId: 2 }),
      ax("b", "button", "Save", { backendDOMNodeId: 3 }),
    ]);
    const first = await snapshot(target(cdp), {}, refs);
    expect(first.text).toContain('- heading "Sign up" [level=1]');
    expect(first.text).toMatch(/- textbox "Name" \[ref=e\d+\]/);
    expect(first.refCount).toBe(2);
    const second = await snapshot(target(cdp), {}, refs);
    expect(second.text).toBe(first.text);

    const interactive = await snapshot(target(cdp), { interactive: true }, refs);
    expect(interactive.text).not.toContain("heading");
    expect(interactive.text.split("\n")).toHaveLength(2);
  });

  it("returns only what changed in delta mode", async () => {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("b", "button", "Save", { backendDOMNodeId: 3 })]);
    await snapshot(target(cdp), {}, refs);
    cdp.nodes = page([ax("b", "button", "Save", { backendDOMNodeId: 3 }), ax("s", "StaticText", "Saved!")]);
    const delta = await snapshot(target(cdp), { delta: true }, refs);
    expect(delta.delta).toBe(true);
    expect(delta.text).toBe('+ - StaticText "Saved!"');
  });

  it("caps a snapshot at the character limit and says so", async () => {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page(Array.from({ length: 2_000 }, (_, index) =>
      ax(`l${index}`, "link", `Result number ${index} with a fairly long accessible name to fill the page`, { backendDOMNodeId: 100 + index })));
    const shot = await snapshot(target(cdp), {}, refs);
    expect(shot.truncated).toBe(true);
    expect(shot.text.length).toBeLessThanOrEqual(SNAPSHOT_MAX_CHARS + 200);
    expect(shot.text).toMatch(/\[truncated: \d+ more lines over the 50000-character limit/);
  });
});

describe("resolving refs", () => {
  it("follows an element the page re-rendered as a new node", async () => {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("b", "button", "Save", { backendDOMNodeId: 3 })]);
    const shot = await snapshot(target(cdp), {}, refs);
    const ref = /\[ref=(e\d+)\]/.exec(shot.text)![1]!;

    // A framework re-render replaces the button with an identical one.
    cdp.nodes = page([ax("b2", "button", "Save", { backendDOMNodeId: 42 })]);
    const tab = target(cdp);
    await click(tab, ref, refs);
    expect(refs.get(ref)?.backendNodeId).toBe(42);
    expect(cdp.inputs()).toEqual(["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
    expect(tab.injected).toHaveLength(1);
    // The next snapshot keeps the same ref for the new node.
    expect((await snapshot(target(cdp), {}, refs)).text).toContain(`[ref=${ref}]`);
  });

  it("fails clearly on a stale ref and touches nothing", async () => {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("b", "button", "Save", { backendDOMNodeId: 3 })]);
    const ref = /\[ref=(e\d+)\]/.exec((await snapshot(target(cdp), {}, refs)).text)![1]!;

    // The element is gone.
    cdp.nodes = page([ax("c", "button", "Cancel", { backendDOMNodeId: 4 })]);
    await expect(click(target(cdp), ref, refs)).rejects.toMatchObject({ code: "stale-ref", message: expect.stringContaining('button "Save"') });

    // The tab navigated.
    cdp.nodes = page([ax("b", "button", "Save", { backendDOMNodeId: 3 })]);
    await expect(click(target(cdp, { url: "https://a.example/other" }), ref, refs)).rejects.toMatchObject({ code: "stale-ref" });

    // Another tab's ref.
    await expect(resolveRef(target(cdp, { tabId: "tab-2" }), ref, refs)).rejects.toMatchObject({ code: "unknown-ref" });
    await expect(resolveRef(target(cdp), "e9999", refs)).rejects.toMatchObject({ code: "unknown-ref" });
    expect(cdp.inputs()).toEqual([]);
  });

  it("does not follow a re-render when the fingerprint is ambiguous", async () => {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("b", "button", "Delete", { backendDOMNodeId: 3 })]);
    const ref = /\[ref=(e\d+)\]/.exec((await snapshot(target(cdp), {}, refs)).text)![1]!;
    cdp.nodes = page([
      ax("x", "button", "Delete", { backendDOMNodeId: 7 }),
      ax("y", "button", "Delete", { backendDOMNodeId: 8 }),
    ]);
    await expect(click(target(cdp), ref, refs)).rejects.toMatchObject({ code: "stale-ref" });
    expect(cdp.inputs()).toEqual([]);
  });
});

describe("typing", () => {
  async function field(attributes: Record<string, string>) {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("f", "textbox", "Field", { backendDOMNodeId: 5 })]);
    cdp.attributes.set(5, attributes);
    const ref = /\[ref=(e\d+)\]/.exec((await snapshot(target(cdp), {}, refs)).text)![1]!;
    return { cdp, ref, refs };
  }

  it.each([
    [{ type: "password" }, "a password field"],
    [{ type: "PASSWORD" }, "a password field"],
    [{ autocomplete: "cc-number" }, "a payment card field"],
    [{ autocomplete: "billing cc-csc" }, "a payment card field"],
    [{ autocomplete: "one-time-code" }, "a one-time code field"],
    [{ autocomplete: "current-password" }, "a password field"],
  ])("refuses to type into %o", async (attributes, reason) => {
    const { cdp, ref, refs } = await field(attributes);
    await expect(typeInto(target(cdp), ref, "secret", {}, refs)).rejects.toMatchObject({
      code: "sensitive-field",
      message: expect.stringContaining(reason),
    });
    expect(cdp.inputs()).toEqual([]);
    expect(cdp.calls.some((call) => call.method === "DOM.focus")).toBe(false);
  });

  it("types into an ordinary field, replacing its value, and submits on request", async () => {
    const { cdp, ref, refs } = await field({ type: "text", autocomplete: "name" });
    await typeInto(target(cdp), ref, "Ada", { submit: true }, refs);
    expect(cdp.calls.find((call) => call.method === "Input.insertText")?.params).toEqual({ text: "Ada" });
    // It clicks into the field before typing.
    expect(cdp.inputs().slice(0, 4)).toEqual(["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent"]);
    expect(cdp.calls.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => call.params?.key)).toEqual(["a", "a", "Enter", "Enter"]);
    expect(sensitiveFieldReason({ type: "email" })).toBeNull();
  });

  it("does nothing once the tab's actions are cancelled", async () => {
    const { cdp, ref, refs } = await field({ type: "text" });
    const controller = new AbortController();
    controller.abort(new Error("the user took over this tab"));
    await expect(typeInto(target(cdp, { signal: controller.signal }), ref, "x", {}, refs)).rejects.toMatchObject({
      code: "cancelled",
      message: expect.stringContaining("the user took over this tab"),
    });
    expect(cdp.inputs()).toEqual([]);
  });
});

describe("navigate", () => {
  type Redirect = { url: string; isMainFrame: boolean; preventDefault: () => void };
  class FakeNavGuest extends EventEmitter implements NavigableGuest {
    url = "about:blank";
    stopped = false;
    constructor(private readonly redirects: string[], private readonly final: string) {
      super();
    }
    async loadURL(_url: string): Promise<void> {
      for (const redirect of this.redirects) {
        let prevented = false;
        const details: Redirect = { url: redirect, isMainFrame: true, preventDefault: () => { prevented = true; } };
        this.emit("will-redirect", details);
        if (prevented) throw new Error("ERR_ABORTED (-3) loading");
      }
      this.url = this.final;
    }
    getURL(): string {
      return this.url;
    }
    stop(): void {
      this.stopped = true;
    }
  }

  it("follows a same-origin redirect", async () => {
    const guest = new FakeNavGuest(["https://a.example/login"], "https://a.example/login");
    await expect(navigate(guest, "https://a.example/", "https://a.example:443", new AbortController().signal, browserOrigin))
      .resolves.toEqual({ url: "https://a.example/login" });
  });

  it("refuses a redirect to another origin than the approved one", async () => {
    const guest = new FakeNavGuest(["https://evil.example/"], "https://evil.example/");
    const result = navigate(guest, "https://a.example/", "https://a.example:443", new AbortController().signal, browserOrigin);
    await expect(result).rejects.toBeInstanceOf(BrowserActionError);
    await expect(result).rejects.toMatchObject({ code: "cross-origin-redirect", message: expect.stringContaining("https://evil.example:443") });
    expect(guest.url).toBe("about:blank");
    expect(guest.listenerCount("will-redirect")).toBe(0);
  });

  it("an http redirect from https is another origin", async () => {
    const guest = new FakeNavGuest(["http://a.example/"], "http://a.example/");
    await expect(navigate(guest, "https://a.example/", "https://a.example:443", new AbortController().signal, browserOrigin))
      .rejects.toMatchObject({ code: "cross-origin-redirect" });
  });

  it("stops the load when the tab's actions are cancelled", async () => {
    const controller = new AbortController();
    const guest = new FakeNavGuest([], "https://a.example/");
    const load = vi.spyOn(guest, "loadURL").mockImplementation(async () => {
      controller.abort(new Error("the user stopped the agent in this tab"));
    });
    await expect(navigate(guest, "https://a.example/", "https://a.example:443", controller.signal, browserOrigin))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(load).toHaveBeenCalledOnce();
    expect(guest.stopped).toBe(true);
  });
});

describe("settle", () => {
  it("waits for a committed URL and the load to finish", async () => {
    let polls = 0;
    const guest = {
      getURL: () => (polls++ >= 2 ? "http://127.0.0.1:8775/index.html" : ""),
      isLoading: () => polls < 5,
    };
    await expect(settle(guest, new AbortController().signal)).resolves.toEqual({ url: "http://127.0.0.1:8775/index.html" });
    expect(polls).toBeGreaterThanOrEqual(5);
  });

  it("gives up at its bound and stops on cancel", async () => {
    const guest = { getURL: () => "", isLoading: () => true };
    await expect(settle(guest, new AbortController().signal, 150)).resolves.toEqual({ url: "" });
    const controller = new AbortController();
    controller.abort(new Error("the user took over this tab"));
    await expect(settle(guest, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("snapshot noise", () => {
  it("leaves out InlineTextBox lines", async () => {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = [
      ax("root", "RootWebArea", "Fixture", { childIds: ["t"] }),
      ax("t", "StaticText", "Hello", { parentId: "root", childIds: ["i"] }),
      ax("i", "InlineTextBox", "Hello", { parentId: "t" }),
    ];
    const shot = await snapshot(target(cdp), {}, refs);
    expect(shot.text).toBe('- RootWebArea "Fixture"\n  - StaticText "Hello"');
  });
});

describe("pressing keys", () => {
  it("refuses a bare key press when the page holds no focus, instead of dropping it", async () => {
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("f", "textbox", "Field", { backendDOMNodeId: 5 })]);
    await expect(pressKey(target(cdp), "Enter", undefined, new BrowserRefTable())).rejects.toMatchObject({ code: "no-focus" });
    expect(cdp.inputs()).toEqual([]);
  });

  it("presses into what the page has focused", async () => {
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("f", "textbox", "Field", { backendDOMNodeId: 5 })]);
    cdp.nodes[0] = { ...cdp.nodes[0]!, properties: [{ name: "focused", value: { type: "booleanOrUndefined", value: true } }] };
    await pressKey(target(cdp), "Escape", undefined, new BrowserRefTable());
    expect(cdp.calls.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => call.params?.key)).toEqual(["Escape", "Escape"]);
  });

  it("clicks into a named element before pressing", async () => {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("f", "textbox", "Field", { backendDOMNodeId: 5 })]);
    const ref = /\[ref=(e\d+)\]/.exec((await snapshot(target(cdp), {}, refs)).text)![1]!;
    await pressKey(target(cdp), "Backspace", ref, refs);
    expect(cdp.inputs()).toEqual([
      "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
    ]);
  });

  it("refuses Enter or Space into an element a click already activates", async () => {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("b", "button", "Submit", { backendDOMNodeId: 6 })]);
    const ref = /\[ref=(e\d+)\]/.exec((await snapshot(target(cdp), {}, refs)).text)![1]!;
    await expect(pressKey(target(cdp), "Enter", ref, refs)).rejects.toMatchObject({ code: "use-click" });
    await expect(pressKey(target(cdp), "Space", ref, refs)).rejects.toMatchObject({ code: "use-click" });
    expect(cdp.inputs()).toEqual([]);
    await pressKey(target(cdp), "Tab", ref, refs);
    expect(cdp.inputs().filter((method) => method === "Input.dispatchKeyEvent")).toHaveLength(2);
  });
});

describe("screenshot", () => {
  it("fails clearly instead of hanging when the tab draws no frame", async () => {
    const cdp = new FakeCdp();
    vi.spyOn(cdp, "send").mockImplementation(() => new Promise(() => {}));
    await expect(screenshot(target(cdp, { tabId: "tab-7" }), 50)).rejects.toMatchObject({
      code: "screenshot-timeout",
      message: expect.stringContaining('browser_tabs {"select": "tab-7"}'),
    });
  });
});

describe("focus before keyboard input", () => {
  async function textField(focusLag: number) {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.focusLag = focusLag;
    cdp.nodes = page([ax("f", "textbox", "Field", { backendDOMNodeId: 5, value: { type: "string", value: "" } })]);
    const ref = /\[ref=(e\d+)\]/.exec((await snapshot(target(cdp), {}, refs)).text)![1]!;
    return { cdp, ref, refs };
  }

  it("waits for the press to give the page focus before typing", async () => {
    const { cdp, ref, refs } = await textField(3);
    await typeInto(target(cdp), ref, "Ada", {}, refs);
    const methods = cdp.calls.map((call) => call.method);
    const firstKey = methods.indexOf("Input.dispatchKeyEvent");
    const lastPress = cdp.calls.slice(0, firstKey).map((call) => call.params?.type).lastIndexOf("mousePressed");
    // Focus checks ran after the last press and before the first key.
    expect(methods.slice(lastPress, firstKey).filter((method) => method === "Accessibility.getFullAXTree").length).toBeGreaterThan(3);
    expect(cdp.calls.find((call) => call.method === "Input.insertText")?.params).toEqual({ text: "Ada" });
  });

  it("types nothing and says so when the page never takes focus", async () => {
    const { cdp, ref, refs } = await textField(Number.POSITIVE_INFINITY);
    await expect(typeInto(target(cdp), ref, "Ada", {}, refs)).rejects.toMatchObject({ code: "no-focus" });
    expect(cdp.calls.some((call) => call.method === "Input.dispatchKeyEvent" || call.method === "Input.insertText")).toBe(false);
  }, 10_000);

  it("types again when the text was lost to a focus change, and reports a field it never reaches", async () => {
    const lost = await textField(0);
    lost.cdp.dropTexts = 1;
    await typeInto(target(lost.cdp), lost.ref, "Ada", {}, lost.refs);
    expect(lost.cdp.calls.filter((call) => call.method === "Input.insertText")).toHaveLength(2);

    const never = await textField(0);
    never.cdp.dropTexts = 99;
    await expect(typeInto(target(never.cdp), never.ref, "Ada", { submit: true }, never.refs)).rejects.toMatchObject({ code: "not-typed" });
    expect(never.cdp.calls.filter((call) => call.method === "Input.insertText")).toHaveLength(3);
    // No Enter after text that never landed.
    expect(never.cdp.calls.some((call) => call.method === "Input.dispatchKeyEvent" && call.params?.key === "Enter")).toBe(false);
  }, 10_000);
});

describe("focus hand-back", () => {
  async function field() {
    const refs = new BrowserRefTable();
    const cdp = new FakeCdp();
    cdp.nodes = page([ax("f", "textbox", "Field", { backendDOMNodeId: 5, value: { type: "string", value: "" } })]);
    const ref = /\[ref=(e\d+)\]/.exec((await snapshot(target(cdp), {}, refs)).text)![1]!;
    return { cdp, ref, refs };
  }

  it("gives focus back once after typing, inside the agent's input window", async () => {
    const { cdp, ref, refs } = await field();
    const tab = target(cdp);
    let inside = false;
    const released: boolean[] = [];
    const wrapped = { ...tab, injectInput: async <T,>(inject: () => Promise<T>) => { inside = true; try { return await inject(); } finally { inside = false; } }, releaseFocus: () => { released.push(inside); cdp.loseFocus(); } };
    await typeInto(wrapped, ref, "Ada", {}, refs);
    expect(released).toEqual([true]);
  });

  it("gives focus back after a click and after a failed action too", async () => {
    const { cdp, ref, refs } = await field();
    const tab = target(cdp);
    await click(tab, ref, refs);
    expect(tab.released).toHaveLength(1);

    const failing = await field();
    failing.cdp.dropTexts = 99;
    const failingTab = target(failing.cdp);
    await expect(typeInto(failingTab, failing.ref, "Ada", {}, failing.refs)).rejects.toMatchObject({ code: "not-typed" });
    expect(failingTab.released).toHaveLength(1);
  }, 10_000);

  it("leaves focus with the page when the page already had it", async () => {
    const { cdp, ref, refs } = await field();
    cdp.nodes[0] = { ...cdp.nodes[0]!, properties: [{ name: "focused", value: { type: "booleanOrUndefined", value: true } }] };
    const tab = target(cdp);
    await pressKey(tab, "Escape", undefined, refs);
    await typeInto(tab, ref, "Ada", {}, refs);
    expect(tab.released).toEqual([]);
  });
});
