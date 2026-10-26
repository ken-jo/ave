// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpTab } from "../McpTab.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("McpTab empty state", () => {
  it("allows a long configuration path to wrap without hiding its text", async () => {
    const configPath = `/tmp/${"isolated-config-directory-".repeat(12)}/mcp/servers.json`;
    vi.stubGlobal("ave", { mcp: {
      servers: vi.fn(async () => []),
      getConfigs: vi.fn(async () => []),
      getConfigPath: vi.fn(async () => configPath),
    } });
    render(<McpTab />);

    const path = await screen.findByText(configPath);
    expect(path.tagName).toBe("CODE");
    expect(path).toHaveClass("[overflow-wrap:anywhere]");
    expect(path).not.toHaveClass("truncate", "line-clamp-1");
    expect(path.textContent).toBe(configPath);
    expect(path.closest(".border-dashed")).toHaveClass("min-w-0");
  });
});

describe("McpTab remove flow", () => {
  it("offers a write-only key for an installed plugin server without a remove-config action", async () => {
    const id = 'bundled:["agent-plugin","meeting-kit","notes"]';
    const mcp = {
      servers: vi.fn(async () => []),
      getConfigs: vi.fn(async () => [{ id, transport: "http" as const, url: "https://example.test/mcp", auth: "api-key" as const,
        apiKeyHeader: "X-Token", bundled: { kind: "agent-plugin" as const, name: "meeting-kit", server: "notes" } }]),
      getConfigPath: vi.fn(async () => "/tmp/ave-test-fixture/.mcp.json"),
      setApiKey: vi.fn(async () => ({ connected: false, warning: "server did not connect" })),
      removeConfig: vi.fn(),
    };
    vi.stubGlobal("ave", { mcp });
    render(<McpTab />);
    expect(await screen.findByText("플러그인: meeting-kit/notes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "제거" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "키 설정" }));
    fireEvent.change(screen.getByLabelText("API 키 (저장 전용)"), { target: { value: "private-value" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(mcp.setApiKey).toHaveBeenCalledWith(id, "private-value"));
  });

  it("prevents duplicate remove requests while one is already in flight", async () => {
    const removal = deferred<void>();
    const mcp = {
      servers: vi.fn(async () => []),
      kill: vi.fn(async () => undefined),
      getConfigs: vi.fn(async () => [{ id: "srv-a", transport: "http" as const, url: "https://example.com/mcp" }]),
      getConfigPath: vi.fn(async () => "/tmp/ave-test-fixture/.mcp.json"),
      addConfig: vi.fn(async () => ({ connected: true })),
      removeConfig: vi.fn(() => removal.promise),
    };

    vi.stubGlobal("ave", { mcp });
    render(<McpTab />);

    const removeButton = await screen.findByRole("button", { name: "제거" });
    fireEvent.click(removeButton);
    fireEvent.click(removeButton);

    expect(mcp.removeConfig).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(removeButton).toBeDisabled());

    removal.resolve();

    await waitFor(() => expect(mcp.getConfigs).toHaveBeenCalledTimes(2));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
