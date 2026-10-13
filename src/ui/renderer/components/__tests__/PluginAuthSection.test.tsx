import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PluginAuthSection } from "../PluginAuthSection.js";
import type { AveApi, PluginAuthSummary } from "../../types.js";
import type { PluginAuthState } from "../../hooks/use-plugin-auth-status.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";

const baseAuth: PluginAuthSummary = {
  label: "Microsoft 계정",
  statusTool: "ms_status",
  loginTool: "ms_login",
  logoutTool: "ms_signout",
};

function pluginAuthSectionApi(overrides?: Partial<AveApi>): AveApi {
  const { api } = makeMockAveApi();
  const callPluginMethod = vi.fn(async () => ({ authenticated: true }));
  Object.assign(api, {
    callPluginMethod,
    onPluginEvent: vi.fn(() => () => undefined),
    ...overrides,
  });
  return api as unknown as AveApi;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PluginAuthSection", () => {
  it("renders 미인증 badge + 로그인 button when state is unauthed", () => {
    const api = pluginAuthSectionApi();
    render(
      <PluginAuthSection
        api={api}
        pluginId="samplemail"
        pluginName="samplemail"
        auth={baseAuth}
        state={{ kind: "unauthed" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("🔒 미인증")).toBeInTheDocument();
    expect(screen.getByTestId("plugin-auth-login-samplemail")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-auth-logout-samplemail")).toBeNull();
  });

  it("renders 인증됨 badge + account + 로그아웃 button when state is authed", () => {
    render(
      <PluginAuthSection
        api={pluginAuthSectionApi()}
        pluginId="samplemail"
        pluginName="samplemail"
        auth={baseAuth}
        state={{ kind: "authed", account: "user@example.com" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("✓ 인증됨")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("plugin-auth-logout-samplemail")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-auth-login-samplemail")).toBeNull();
  });

  it("hides 로그아웃 button + shows hint when manifest does not declare logoutTool", () => {
    render(
      <PluginAuthSection
        api={pluginAuthSectionApi()}
        pluginId="sampleportal"
        pluginName="sampleportal"
        auth={{ statusTool: "portal_status", loginTool: "portal_login" }}
        state={{ kind: "authed", account: "alice@example.com" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("✓ 인증됨")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-auth-logout-sampleportal")).toBeNull();
    expect(screen.getByTestId("plugin-auth-logout-hint-sampleportal")).toBeInTheDocument();
  });

  it("invokes loginTool + onRefresh when 로그인 clicked", async () => {
    const api = pluginAuthSectionApi();
    const onRefresh = vi.fn();
    render(
      <PluginAuthSection
        api={api}
        pluginId="samplemail"
        pluginName="samplemail"
        auth={baseAuth}
        state={{ kind: "unauthed" }}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-auth-login-samplemail"));
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("ms_login", undefined, {
        userAction: true,
      });
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("invokes logoutTool + onRefresh when 로그아웃 clicked", async () => {
    const api = pluginAuthSectionApi();
    const onRefresh = vi.fn();
    render(
      <PluginAuthSection
        api={api}
        pluginId="samplemail"
        pluginName="samplemail"
        auth={baseAuth}
        state={{ kind: "authed", account: "user@example.com" }}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-auth-logout-samplemail"));
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("ms_signout", undefined, {
        userAction: true,
      });
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("falls back to pluginName when auth.label is empty", () => {
    render(
      <PluginAuthSection
        api={pluginAuthSectionApi()}
        pluginId="x"
        pluginName="Cool Plugin"
        auth={{ statusTool: "x_status", loginTool: "x_login" }}
        state={{ kind: "unauthed" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("Cool Plugin")).toBeInTheDocument();
  });

  it("renders error badge when state is error", () => {
    render(
      <PluginAuthSection
        api={pluginAuthSectionApi()}
        pluginId="x"
        pluginName="x"
        auth={baseAuth}
        state={{ kind: "error", message: "boom" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("⚠ 오류")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders generic Korean error copy on login rejection (does not leak raw IPC message)", async () => {
    const api = {
      callPluginMethod: vi.fn(async () => {
        throw new Error("Method 'samplemail_auth' is not declared as a UI action for plugin 'samplemail'");
      }),
      onPluginEvent: vi.fn(() => () => undefined),
    } as unknown as AveApi;
    // Silence the console.error the component emits for triage logging.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <PluginAuthSection
          api={api}
          pluginId="samplemail"
          pluginName="samplemail"
          auth={baseAuth}
          state={{ kind: "unauthed" }}
          onRefresh={() => undefined}
        />,
      );
      fireEvent.click(screen.getByTestId("plugin-auth-login-samplemail"));
      await waitFor(() => {
        expect(screen.getByText(/로그인에 실패했습니다/)).toBeInTheDocument();
      });
      // Raw IPC message must NOT appear in the rendered UI.
      expect(screen.queryByText(/UI action/)).toBeNull();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
