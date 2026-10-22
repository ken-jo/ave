// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpTab } from "../McpTab.js";
import type { McpConfigMutationResult } from "../../../../mcp/types.js";
import type { McpServerConfigDto, McpServerState } from "../../types.js";

function setup(
  configs: McpServerConfigDto[] = [{ id: "remote-a", transport: "http", url: "https://example.test/mcp", auth: "oauth", oauth: {} }],
  states: McpServerState[] = [{ id: "remote-a", status: "disconnected", registeredTools: [], authStatus: "required" }],
) {
  const mcp = {
    servers: vi.fn(async () => states),
    getConfigs: vi.fn(async () => configs),
    getConfigPath: vi.fn(async () => "/tmp/ave-test-fixture/.mcp.json"),
    authenticate: vi.fn(async (): Promise<{ connected: boolean; errorCode?: string }> => ({ connected: true })),
    addConfig: vi.fn(async (): Promise<McpConfigMutationResult> => ({ connected: false })),
  };
  vi.stubGlobal("ave", { mcp });
  render(<McpTab />);
  return mcp;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("McpTab browser authentication", () => {
  it.each<McpServerConfigDto>([
    { id: "remote-a", transport: "http", url: "https://example.test/mcp", oauth: {} },
    { id: "remote-a", transport: "stdio", command: "local-server" },
  ])("does not offer authentication for an unenrolled $transport server", async (config) => {
    setup([config], []);
    await screen.findByText("remote-a");
    expect(screen.queryByRole("button", { name: "인증하기" })).toBeNull();
  });

  it("does not offer authentication for a bundled server", async () => {
    setup([{ id: 'bundled:["agent-plugin","meeting-kit","notes"]', transport: "http", url: "https://example.test/mcp", auth: "oauth",
      bundled: { kind: "agent-plugin", name: "meeting-kit", server: "notes" } }], []);
    await screen.findByText("플러그인: meeting-kit/notes");
    expect(screen.queryByRole("button", { name: "인증하기" })).toBeNull();
  });

  it("shows required status and prevents duplicate actions while authentication is pending", async () => {
    const mcp = setup();
    let resolve!: (value: { connected: boolean }) => void;
    mcp.authenticate.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const button = await screen.findByRole("button", { name: "인증하기" });
    expect(screen.getByRole("status")).toHaveTextContent("인증 필요");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mcp.authenticate).toHaveBeenCalledTimes(1);
    expect(mcp.authenticate).toHaveBeenCalledWith("remote-a");
    expect(screen.getByRole("button", { name: "인증 중…" })).toBeDisabled();
    resolve({ connected: true });
    expect(await screen.findByText("remote-a 인증 및 연결이 완료되었습니다.")).toBeInTheDocument();
    await waitFor(() => expect(mcp.servers).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["mcp-auth-required", "서버에 연결하려면 다시 인증하세요."],
    ["mcp-auth-failed", "인증 또는 연결에 실패했습니다. 다시 시도하세요."],
  ])("localizes %s without showing provider text", async (errorCode, message) => {
    const mcp = setup();
    mcp.authenticate.mockResolvedValueOnce({ connected: false, errorCode });
    fireEvent.click(await screen.findByRole("button", { name: "인증하기" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("reflects a revoked session without remounting settings", async () => {
    vi.useFakeTimers();
    let mcp!: ReturnType<typeof setup>;
    await act(async () => { mcp = setup(); });
    mcp.servers.mockResolvedValue([{ id: "remote-a", status: "disconnected", registeredTools: [], authStatus: "authenticated" }]);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByRole("status")).toHaveTextContent("인증됨");
    mcp.servers.mockResolvedValue([{ id: "remote-a", status: "disconnected", registeredTools: [], authStatus: "required" }]);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByRole("status")).toHaveTextContent("인증 필요");
  });

  it("ignores a stale poll response after authentication refreshes the server", async () => {
    vi.useFakeTimers();
    let mcp!: ReturnType<typeof setup>;
    await act(async () => { mcp = setup(); });
    let resolve!: (states: Awaited<ReturnType<typeof mcp.servers>>) => void;
    mcp.servers.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(mcp.servers).toHaveBeenCalledTimes(2);
    mcp.servers.mockResolvedValue([{ id: "remote-a", status: "connected", registeredTools: [], authStatus: "authenticated" }]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "인증하기" })); });
    expect(screen.getByRole("status")).toHaveTextContent("인증됨");
    await act(async () => { resolve([{ id: "remote-a", status: "disconnected", registeredTools: [], authStatus: "required" }]); });
    expect(screen.getByRole("status")).toHaveTextContent("인증됨");
  });

  it("replaces authentication error details with localized guidance", async () => {
    setup(undefined, [{ id: "remote-a", status: "error", registeredTools: [], authStatus: "error", lastError: "private-value" }]);
    expect(await screen.findByRole("status")).toHaveTextContent("인증 오류");
    expect(screen.getByText("인증 또는 연결에 실패했습니다. 다시 시도하세요.")).toBeInTheDocument();
    expect(screen.queryByText(/private-value/)).toBeNull();
  });

  it("does not display exception details from the bridge", async () => {
    const mcp = setup();
    mcp.authenticate.mockRejectedValueOnce(new Error("private-value"));
    fireEvent.click(await screen.findByRole("button", { name: "인증하기" }));
    expect(await screen.findByText("인증 또는 연결에 실패했습니다. 다시 시도하세요.")).toBeInTheDocument();
    expect(screen.queryByText(/private-value/)).toBeNull();
  });

  it.each([
    { errorCode: "mcp-auth-required" as const, message: "remote-b 설정을 저장했습니다. 연결하려면 인증하세요." },
    { errorCode: "mcp-auth-failed" as const, message: "인증 또는 연결에 실패했습니다. 다시 시도하세요." },
  ])("creates an HTTP discovery-only configuration and localizes $errorCode", async ({ errorCode, message }) => {
    const mcp = setup();
    await screen.findByRole("button", { name: "인증하기" });
    fireEvent.click(screen.getByRole("button", { name: "+ 서버 추가" }));
    expect(screen.queryByRole("option", { name: "OAuth (브라우저)" })).toBeNull();
    fireEvent.change(screen.getByLabelText("전송 방식 *"), { target: { value: "http" } });
    expect(screen.getByRole("option", { name: "OAuth (브라우저)" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("서버 ID *"), { target: { value: "remote-b" } });
    fireEvent.change(screen.getByLabelText("URL *"), { target: { value: "https://example.test/other" } });
    fireEvent.change(screen.getByLabelText("인증"), { target: { value: "oauth" } });
    expect(screen.getByLabelText("API 키 (저장 전용)")).toBeDisabled();
    mcp.addConfig.mockResolvedValueOnce({ connected: false, errorCode });
    fireEvent.click(screen.getByRole("button", { name: "추가" }));
    await waitFor(() => expect(mcp.addConfig).toHaveBeenCalledWith({ id: "remote-b", transport: "http", auth: "oauth", oauth: {}, url: "https://example.test/other", allowPrivateNetworks: false }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mcp.authenticate).not.toHaveBeenCalled();
  });
});
