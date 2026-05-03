import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PluginAuthSection } from "../PluginAuthSection.js";
import type { AveApi, PluginAuthSummary } from "../../types.js";
import type { PluginAuthState } from "../../hooks/use-plugin-auth-status.js";

const baseAuth: PluginAuthSummary = {
  label: "Microsoft 계정",
  statusTool: "ms_status",
  loginTool: "ms_login",
  logoutTool: "ms_signout",
};

function makeApi(overrides?: Partial<AveApi>): AveApi {
  const callPluginMethod = vi.fn(async () => ({ authenticated: true }));
  return {
    callPluginMethod,
    onPluginEvent: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as AveApi;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PluginAuthSection", () => {
  it("renders 미인증 badge + 로그인 button when state is unauthed", () => {
    const api = makeApi();
    render(
      <PluginAuthSection
        api={api}
        pluginId="lyra-mail"
        pluginName="lyra-mail"
        auth={baseAuth}
        state={{ kind: "unauthed" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("🔒 미인증")).toBeInTheDocument();
    expect(screen.getByTestId("plugin-auth-login-lyra-mail")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-auth-logout-lyra-mail")).toBeNull();
  });

  it("renders 인증됨 badge + account + 로그아웃 button when state is authed", () => {
    render(
      <PluginAuthSection
        api={makeApi()}
        pluginId="lyra-mail"
        pluginName="lyra-mail"
        auth={baseAuth}
        state={{ kind: "authed", account: "user@example.com" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("✓ 인증됨")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("plugin-auth-logout-lyra-mail")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-auth-login-lyra-mail")).toBeNull();
  });

  it("hides 로그아웃 button + shows hint when manifest does not declare logoutTool", () => {
    render(
      <PluginAuthSection
        api={makeApi()}
        pluginId="orion-api"
        pluginName="orion-api"
        auth={{ statusTool: "acme_status", loginTool: "acme_login" }}
        state={{ kind: "authed", account: "jo.dreame@gmail.com" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("✓ 인증됨")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-auth-logout-orion-api")).toBeNull();
    expect(screen.getByTestId("plugin-auth-logout-hint-orion-api")).toBeInTheDocument();
  });

  it("invokes loginTool + onRefresh when 로그인 clicked", async () => {
    const api = makeApi();
    const onRefresh = vi.fn();
    render(
      <PluginAuthSection
        api={api}
        pluginId="lyra-mail"
        pluginName="lyra-mail"
        auth={baseAuth}
        state={{ kind: "unauthed" }}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-auth-login-lyra-mail"));
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("ms_login");
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("opens provided login UI instead of invoking loginTool", async () => {
    const api = makeApi();
    const onOpenLoginUi = vi.fn(async () => ({ ok: true }));
    const onRefresh = vi.fn();
    render(
      <PluginAuthSection
        api={api}
        pluginId="detached-plugin"
        pluginName="Detached Plugin"
        auth={{ ...baseAuth, loginTool: "detached_login" }}
        state={{ kind: "unauthed" }}
        onOpenLoginUi={onOpenLoginUi}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByTestId("plugin-auth-login-detached-plugin")).toHaveTextContent("로그인 창 열기");
    fireEvent.click(screen.getByTestId("plugin-auth-login-detached-plugin"));
    await waitFor(() => {
      expect(onOpenLoginUi).toHaveBeenCalledOnce();
    });
    expect(api.callPluginMethod).not.toHaveBeenCalledWith("detached_login");
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("invokes logoutTool + onRefresh when 로그아웃 clicked", async () => {
    const api = makeApi();
    const onRefresh = vi.fn();
    render(
      <PluginAuthSection
        api={api}
        pluginId="lyra-mail"
        pluginName="lyra-mail"
        auth={baseAuth}
        state={{ kind: "authed", account: "user@example.com" }}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-auth-logout-lyra-mail"));
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("ms_signout");
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("falls back to pluginName when auth.label is empty", () => {
    render(
      <PluginAuthSection
        api={makeApi()}
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
        api={makeApi()}
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
        throw new Error("Method 'lyramail_auth' is not UI-callable for plugin 'lyra-mail'");
      }),
      onPluginEvent: vi.fn(() => () => undefined),
    } as unknown as AveApi;
    // Silence the console.error the component emits for triage logging.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <PluginAuthSection
          api={api}
          pluginId="lyra-mail"
          pluginName="lyra-mail"
          auth={baseAuth}
          state={{ kind: "unauthed" }}
          onRefresh={() => undefined}
        />,
      );
      fireEvent.click(screen.getByTestId("plugin-auth-login-lyra-mail"));
      await waitFor(() => {
        expect(screen.getByText(/로그인에 실패했습니다/)).toBeInTheDocument();
      });
      // Raw IPC message must NOT appear in the rendered UI.
      expect(screen.queryByText(/UI-callable/)).toBeNull();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
