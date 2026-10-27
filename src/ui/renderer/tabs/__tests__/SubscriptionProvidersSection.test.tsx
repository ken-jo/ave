import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { loadLocaleMessages } from "../../../../i18n/messages/index.js";
import {
  subscriptionRuntimeDescriptor,
  type SubscriptionRuntimeCapabilities,
  type SubscriptionRuntimeId,
} from "../../../../shared/subscription-runtime.js";
import {
  SignInMethodChoice,
  SubscriptionAuthControls,
  type SubscriptionProviderStatus,
  type SubscriptionProviderView,
} from "../SubscriptionProvidersSection.js";

function renderProviders(
  providers: readonly SubscriptionProviderView[],
  actions: Parameters<typeof SubscriptionAuthControls>[0]["actions"],
) {
  return render(<SubscriptionProvidersSection providers={providers} actions={actions} />);
}

function runtimeCapabilities(
  overrides: Partial<SubscriptionRuntimeCapabilities> = {},
): SubscriptionRuntimeCapabilities {
  return {
    chat: true,
    images: true,
    imageAttachmentLimits: {
      maxCount: 5,
      maxBytesPerImage: 25 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
    },
    files: true,
    tools: true,
    projectAccess: true,
    plugins: true,
    mcp: true,
    generateText: true,
    compaction: true,
    routine: true,
    subagent: true,
    ...overrides,
  };
}

const connectedCodex = (overrides: Partial<SubscriptionProviderView> = {}): SubscriptionProviderView => ({
  descriptor: {
    id: "codex",
    label: "Codex",
    planName: "ChatGPT",
    cliName: "Codex CLI",
    executable: "discovered",
    description: "Use your existing ChatGPT subscription.",
    loginMethods: ["browser", "device-code"],
    supportsLogout: true,
  },
  status: {
    runtime: "ready",
    connection: "connected",
    models: [
      { id: "gpt-5.6-codex", label: "GPT-5.6 Codex", isDefault: true },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    ],
    capabilities: runtimeCapabilities(),
  },
  ...overrides,
});

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
});

afterEach(() => {
  setLocale(localeBeforeTest);
});

/** The settings page draws the provider row itself — header, badges, state word, sub-line and refresh — so what ships from
 * this module is the sign-in half, and that is what these tests drive. */
function SubscriptionProvidersSection({
  providers,
  actions,
}: {
  providers: readonly SubscriptionProviderView[];
  actions: Parameters<typeof SubscriptionAuthControls>[0]["actions"];
}) {
  return (
    <div>
      {providers.map((provider) => (
        <SubscriptionAuthControls
          key={provider.descriptor.id}
          provider={provider}
          actions={actions}
        />
      ))}
    </div>
  );
}

describe("SubscriptionAuthControls", () => {
  it("carries nothing but sign-in: no header, no state word, no refresh, no model controls", () => {
    renderProviders([connectedCodex()], { refreshStatus: vi.fn(), useForChat: vi.fn(), logout: vi.fn() });

    // Every one of these belongs to the row the settings page draws, and having it here too is what gave one provider two
    // headers, two state words and two refresh buttons — each computing its own answer.
    for (const testId of [
      "subscription-provider:codex:refresh",
      "subscription-provider:codex:connection",
      "subscription-provider:codex:capabilities",
      "subscription-provider:codex:capability:chat",
      "subscription-provider:codex:load-models",
      "subscription-provider:codex:model-select",
      "subscription-provider:codex:use-for-chat",
      "subscription-provider:codex:active-selection",
    ]) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
    // ...and what it does carry is the half with no API-key counterpart.
    expect(screen.getByTestId("subscription-provider:codex:logout")).toBeInTheDocument();
  });

  it("supports common browser/device login, pending browser opening, cancellation, and logout actions", async () => {
    const beginLogin = vi.fn();
    const openLoginBrowser = vi.fn();
    const cancelLogin = vi.fn();
    const logout = vi.fn();
    const { rerender } = renderProviders([{
          ...connectedCodex(),
          status: {
            runtime: "ready",
            connection: "signed-out",
            capabilities: runtimeCapabilities({ chat: false }),
          },
        }], { beginLogin, openLoginBrowser, cancelLogin, logout });

    fireEvent.click(screen.getByTestId("subscription-provider:codex:login-browser"));
    fireEvent.click(screen.getByTestId("subscription-provider:codex:login-device-code"));
    await waitFor(() => {
      expect(beginLogin).toHaveBeenCalledWith("codex", "browser");
      expect(beginLogin).toHaveBeenCalledWith("codex", "device-code");
    });

    rerender(
      <SubscriptionProvidersSection
        providers={[{
          ...connectedCodex(),
          status: {
            runtime: "ready",
            connection: "pending",
            pendingLoginMethod: "device-code",
            pendingDeviceCode: "Q7KD-9P2M",
            canOpenLoginBrowser: true,
            capabilities: runtimeCapabilities({ chat: false }),
          },
        }]}
        actions={{ beginLogin, openLoginBrowser, cancelLogin, logout }}
      />,
    );

    expect(screen.getByTestId("subscription-provider:codex:device-code")).toHaveTextContent("Q7KD-9P2M");
    fireEvent.click(screen.getByTestId("subscription-provider:codex:open-login-browser"));
    fireEvent.click(screen.getByTestId("subscription-provider:codex:cancel-login"));
    await waitFor(() => {
      expect(openLoginBrowser).toHaveBeenCalledWith("codex");
      expect(cancelLogin).toHaveBeenCalledWith("codex");
    });

    rerender(
      <SubscriptionProvidersSection
        providers={[connectedCodex()]}
        actions={{ logout }}
      />,
    );
    fireEvent.click(screen.getByTestId("subscription-provider:codex:logout"));
    await waitFor(() => expect(logout).toHaveBeenCalledWith("codex"));
  });

  it("never renders URL, token, or raw CLI output fields outside the browser-safe contract", () => {
    const authUrl = "https://auth.example.test/authorize?one-time-secret";
    const token = "secret-access-token";
    const rawCliOutput = "runtime stderr: bearer token=secret-access-token";
    const unsafeProvider = {
      ...connectedCodex(),
      descriptor: {
        ...connectedCodex().descriptor,
        authUrl,
        accessToken: token,
      },
      status: {
        ...connectedCodex().status,
        rawCliOutput,
        verificationUrl: authUrl,
      },
    } as unknown as SubscriptionProviderView;

    renderProviders([unsafeProvider], {});

    expect(document.body).not.toHaveTextContent(authUrl);
    expect(document.body).not.toHaveTextContent(token);
    expect(document.body).not.toHaveTextContent(rawCliOutput);
  });

  it("rejects a device code that looks like a URL or bearer token", () => {
    renderProviders([{
          ...connectedCodex(),
          status: {
            runtime: "ready",
            connection: "pending",
            pendingLoginMethod: "device-code",
            pendingDeviceCode: "https://auth.example.test/secret-token",
            capabilities: runtimeCapabilities({ chat: false }),
          },
        }], {});

    expect(screen.queryByTestId("subscription-provider:codex:device-code")).toBeNull();
    expect(document.body).not.toHaveTextContent("https://auth.example.test/secret-token");
  });

  /** The view the settings controller builds from the shared descriptor. */
  function viewFor(runtimeId: SubscriptionRuntimeId, status: SubscriptionProviderStatus): SubscriptionProviderView {
    const descriptor = subscriptionRuntimeDescriptor(runtimeId);
    return {
      descriptor: {
        id: descriptor.id,
        label: descriptor.label,
        planName: descriptor.planName,
        cliName: descriptor.cliName,
        description: "",
        loginMethods: descriptor.loginMethods,
        executable: descriptor.executable,
        supportsLogout: descriptor.supportsManagedLogout,
        ...(descriptor.minimumVersion ? { minimumVersion: descriptor.minimumVersion } : {}),
        ...(descriptor.installGuidance ? { installGuidance: descriptor.installGuidance } : {}),
      },
      status,
    };
  }

  const PICKER_TEST_IDS = ["configure-runtime", "change-runtime", "forget-runtime"] as const;

  it.each(["claude-code", "kimi-code", "grok-build"] as const)(
    "offers sign-in for a found signed-out runtime (%s)",
    (runtimeId) => {
      const beginLogin = vi.fn();
      renderProviders([viewFor(runtimeId, { runtime: "unverified", connection: "signed-out" })], { beginLogin, verifyRuntime: vi.fn() });

      expect(screen.queryByTestId(`subscription-provider:${runtimeId}:verify-runtime`)).toBeNull();
      for (const method of subscriptionRuntimeDescriptor(runtimeId).loginMethods) {
        fireEvent.click(screen.getByTestId(`subscription-provider:${runtimeId}:login-${method}`));
        expect(beginLogin).toHaveBeenCalledWith(runtimeId, method);
      }
    },
  );

  it.each([
    ["not-configured", "signed-out"],
    ["unavailable", "signed-out"],
    ["checking", "signed-out"],
    ["unverified", "unknown"],
    ["unverified", "connected"],
  ] as const)("does not offer sign-in for %s and %s", (runtime, connection) => {
    renderProviders([viewFor("claude-code", { runtime, connection })], { beginLogin: vi.fn(), verifyRuntime: vi.fn() });
    expect(screen.queryByTestId("subscription-provider:claude-code:login-browser")).toBeNull();
    if (runtime === "unverified") {
      expect(screen.getByTestId("subscription-provider:claude-code:verify-runtime")).toBeInTheDocument();
    }
  });

  it.each([
    ["codex", "Install the Codex CLI to sign in with your ChatGPT plan.", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
    ["claude-code", "Install the Claude Code CLI to sign in with your Claude plan.", "curl -fsSL https://claude.ai/install.sh | bash"],
  ] as const)("shows %s install guidance and Check again, never a file picker, while no CLI is found", (runtimeId, heading, command) => {
    const refreshStatus = vi.fn();
    const configureRuntime = vi.fn();
    renderProviders([viewFor(runtimeId, { runtime: "not-configured", connection: "signed-out" })], { refreshStatus, configureRuntime, forgetRuntime: vi.fn(), beginLogin: vi.fn() });

    const guidance = screen.getByTestId(`subscription-provider:${runtimeId}:install-guidance`);
    expect(guidance).toHaveTextContent(heading);
    expect(guidance).toHaveTextContent(command);
    expect(guidance).toHaveTextContent(subscriptionRuntimeDescriptor(runtimeId).installGuidance!.documentationUrl);
    for (const id of PICKER_TEST_IDS) {
      expect(screen.queryByTestId(`subscription-provider:${runtimeId}:${id}`)).toBeNull();
    }
    expect(screen.queryByTestId(`subscription-provider:${runtimeId}:login-browser`)).toBeNull();
    // Nothing on the card asks the user to pick or browse to a file.
    expect(document.body).not.toHaveTextContent(/select (it|official runtime)|choose a/i);

    fireEvent.click(screen.getByTestId(`subscription-provider:${runtimeId}:check-again`));
    expect(refreshStatus).toHaveBeenCalledWith(runtimeId);
    expect(configureRuntime).not.toHaveBeenCalled();
  });

  it("names the required Codex CLI version in the install guidance", () => {
    const codex = subscriptionRuntimeDescriptor("codex");
    renderProviders([viewFor("codex", { runtime: "not-configured", connection: "signed-out" })], { refreshStatus: vi.fn() });
    expect(screen.getByTestId("subscription-provider:codex:install-guidance"))
      .toHaveTextContent(`Codex CLI ${codex.minimumVersion}+ required.`);
  });

  it("says the found CLI and offers sign-in, with no runtime picker", () => {
    const beginLogin = vi.fn();
    renderProviders([viewFor("codex", { runtime: "ready", connection: "signed-out", version: "0.163.0" })], { beginLogin, configureRuntime: vi.fn(), forgetRuntime: vi.fn(), refreshStatus: vi.fn() });
    expect(screen.getByTestId("subscription-provider:codex:cli-found"))
      .toHaveTextContent("Using the sign-in tool on this computer (version 0.163.0).");
    for (const id of PICKER_TEST_IDS) expect(screen.queryByTestId(`subscription-provider:codex:${id}`)).toBeNull();
    expect(screen.queryByTestId("subscription-provider:codex:install-guidance")).toBeNull();
    fireEvent.click(screen.getByTestId("subscription-provider:codex:login-browser"));
    expect(beginLogin).toHaveBeenCalledWith("codex", "browser");
  });

  it("says which Codex CLI version is required when the found one is too old or incompatible, with update steps", () => {
    const codex = subscriptionRuntimeDescriptor("codex");
    const refreshStatus = vi.fn();
    const view = (errorCode: "subscription-runtime-version-unsupported" | "subscription-runtime-incompatible" | "subscription-runtime-unsafe-location", version: string | null) =>
      viewFor("codex", { runtime: "unavailable", connection: "unknown", version, errorCode });
    const { rerender } = renderProviders([view("subscription-runtime-version-unsupported", "0.151.0")], { refreshStatus });
    expect(screen.getByTestId("subscription-provider:codex:error"))
      .toHaveTextContent("The installed CLI is older than Ave supports.");
    expect(screen.getByTestId("subscription-provider:codex:minimum-version"))
      .toHaveTextContent(`Codex CLI ${codex.minimumVersion}+ required (found 0.151.0).`);
    expect(screen.getByTestId("subscription-provider:codex:update-guidance"))
      .toHaveTextContent("The Codex CLI on this computer is too old for Ave.");
    expect(screen.queryByTestId("subscription-provider:codex:install-guidance")).toBeNull();
    expect(screen.queryByTestId("subscription-provider:codex:cli-found")).toBeNull();
    fireEvent.click(screen.getByTestId("subscription-provider:codex:check-again"));
    expect(refreshStatus).toHaveBeenCalledWith("codex");

    rerender(<SubscriptionProvidersSection providers={[view("subscription-runtime-incompatible", null)]} actions={{ refreshStatus }} />);
    expect(screen.getByTestId("subscription-provider:codex:error"))
      .toHaveTextContent("does not support everything Ave needs");
    expect(screen.getByTestId("subscription-provider:codex:minimum-version"))
      .toHaveTextContent(`Codex CLI ${codex.minimumVersion}+ required.`);
    expect(screen.getByTestId("subscription-provider:codex:update-guidance")).toBeInTheDocument();
    rerender(<SubscriptionProvidersSection providers={[view("subscription-runtime-unsafe-location", null)]} actions={{ refreshStatus }} />);
    expect(screen.getByTestId("subscription-provider:codex:error"))
      .toHaveTextContent("must not be writable by other users");
    expect(screen.queryByTestId("subscription-provider:codex:minimum-version")).toBeNull();
  });

  it.each([
    ["en", "This subscription runtime requires a native installation. Run claude install or use the official native installer, then remove the npm-installed copy and check again."],
    ["ko", "이 구독 실행 환경은 네이티브 설치가 필요합니다. claude install 또는 공식 네이티브 설치 프로그램으로 설치한 다음 npm으로 설치한 복사본을 제거하고 다시 확인하세요."],
  ] as const)("explains manual native migration and offers recheck in %s", async (locale, message) => {
    await loadLocaleMessages(locale);
    setLocale(locale);
    const refreshStatus = vi.fn();
    const beginLogin = vi.fn();
    renderProviders([viewFor("claude-code", { runtime: "unavailable", connection: "unknown", errorCode: "subscription-runtime-native-required" })], { refreshStatus, beginLogin });
    expect(screen.getByTestId("subscription-provider:claude-code:error")).toHaveTextContent(message);
    const guidance = screen.getByTestId("subscription-provider:claude-code:native-install-guidance");
    expect(guidance).toHaveTextContent("claude install");
    expect(guidance).toHaveTextContent("npm uninstall -g @anthropic-ai/claude-code");
    expect(guidance).toHaveTextContent("https://code.claude.com/docs/en/setup");
    expect(guidance).not.toHaveTextContent("npm install");
    expect(screen.queryByTestId("subscription-provider:claude-code:login-browser")).toBeNull();
    expect(beginLogin).not.toHaveBeenCalled();
    expect(within(guidance).getAllByRole("button")).toEqual([screen.getByTestId("subscription-provider:claude-code:check-again")]);
    expect(refreshStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("subscription-provider:claude-code:check-again"));
    expect(refreshStatus).toHaveBeenCalledWith("claude-code");
  });

  it("shows a found Claude Code CLI that lacks what Ave passes as an update, not a picker", () => {
    renderProviders([viewFor("claude-code", { runtime: "unavailable", connection: "unknown", errorCode: "subscription-runtime-incompatible" })], { refreshStatus: vi.fn(), configureRuntime: vi.fn() });
    expect(screen.getByTestId("subscription-provider:claude-code:update-guidance"))
      .toHaveTextContent("The Claude Code CLI on this computer is too old for Ave.");
    expect(screen.getByTestId("subscription-provider:claude-code:check-again")).toBeInTheDocument();
    for (const id of PICKER_TEST_IDS) expect(screen.queryByTestId(`subscription-provider:claude-code:${id}`)).toBeNull();
  });

  it("offers Check again when a found CLI could not be used for another reason", () => {
    const refreshStatus = vi.fn();
    renderProviders([viewFor("claude-code", { runtime: "unavailable", connection: "unknown" })], { refreshStatus });
    expect(screen.getByTestId("subscription-provider:claude-code:cli-unavailable"))
      .toHaveTextContent("The sign-in tool on this computer could not be used just now.");
    fireEvent.click(screen.getByTestId("subscription-provider:claude-code:check-again"));
    expect(refreshStatus).toHaveBeenCalledWith("claude-code");
  });

  it.each(["en", "ko"] as const)("keeps ordinary and transient sign-in states neutral in %s", async (locale) => {
    await loadLocaleMessages(locale);
    setLocale(locale);
    const { rerender } = renderProviders([], { refreshStatus: vi.fn() });
    for (const runtimeId of ["codex", "claude-code"] as const) {
      for (const connection of ["signed-out", "connected"] as const) {
        rerender(
          <SubscriptionProvidersSection
            providers={[viewFor(runtimeId, { runtime: "ready", connection, version: "1.2.3" })]}
            actions={{ beginLogin: vi.fn(), logout: vi.fn() }}
          />,
        );
        expect(screen.getByTestId(`subscription-provider:${runtimeId}:cli-found`)).toHaveTextContent(
          locale === "en"
            ? "Using the sign-in tool on this computer (version 1.2.3)."
            : "이 컴퓨터의 로그인 도구를 사용합니다 (버전 1.2.3).",
        );
        expect(document.body).not.toHaveTextContent(/Codex|Claude Code/);
      }
      rerender(
        <SubscriptionProvidersSection
          providers={[viewFor(runtimeId, { runtime: "unavailable", connection: "unknown", errorCode: "subscription-runtime-unavailable" })]}
          actions={{ refreshStatus: vi.fn() }}
        />,
      );
      expect(screen.getByTestId(`subscription-provider:${runtimeId}:cli-unavailable`)).toHaveTextContent(
        locale === "en"
          ? "The sign-in tool on this computer could not be used just now."
          : "이 컴퓨터의 로그인 도구를 지금 사용할 수 없습니다.",
      );
      expect(document.body).not.toHaveTextContent(/Codex|Claude Code/);
      rerender(
        <SubscriptionProvidersSection
          providers={[viewFor(runtimeId, { runtime: "unavailable", connection: "unknown", version: "1.2.3", errorCode: "subscription-runtime-incompatible" })]}
          actions={{ refreshStatus: vi.fn() }}
        />,
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent(/Codex|Claude Code/);
      expect(screen.getByTestId(`subscription-provider:${runtimeId}:update-guidance`))
        .toHaveTextContent(subscriptionRuntimeDescriptor(runtimeId).cliName);
    }
  });

  it("keeps the official runtime picker for a runtime whose executable the user selects (control)", () => {
    const configureRuntime = vi.fn();
    renderProviders([viewFor("kimi-code", { runtime: "not-configured", connection: "signed-out" })], { configureRuntime, refreshStatus: vi.fn() });
    fireEvent.click(screen.getByTestId("subscription-provider:kimi-code:configure-runtime"));
    expect(configureRuntime).toHaveBeenCalledWith("kimi-code");
    expect(screen.queryByTestId("subscription-provider:kimi-code:check-again")).toBeNull();
  });
});

describe("SignInMethodChoice", () => {
  it.each([
    ["en", "Billed to your own Claude subscription, not an API key.", "Billed to your configured API key."],
    ["ko", "API 키가 아닌 본인의 Claude 구독으로 청구됩니다.", "설정한 본인의 API 키로 청구됩니다."],
  ] as const)("discloses both billing routes before selection in %s", async (locale, subscriptionBilling, apiBilling) => {
    await loadLocaleMessages(locale);
    setLocale(locale);
    render(<SignInMethodChoice rowId="claude-code" planName="Claude" value={null} onChange={vi.fn()} />);
    const group = screen.getByTestId("llm-tab:sign-in-method:claude-code");
    expect(within(group).getByText(subscriptionBilling)).toBeVisible();
    expect(within(group).getByText(apiBilling)).toBeVisible();
    expect(within(group).getByTestId("llm-tab:sign-in-method:claude-code:subscription")).toHaveAccessibleDescription(subscriptionBilling);
    expect(within(group).getByTestId("llm-tab:sign-in-method:claude-code:api")).toHaveAccessibleDescription(apiBilling);
    for (const radio of within(group).getAllByRole("radio")) expect(radio).toHaveAttribute("aria-checked", "false");
  });

  it("asks with nothing chosen, then reports the method picked", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SignInMethodChoice rowId="codex" planName="ChatGPT" value={null} onChange={onChange} />);
    const subscription = screen.getByTestId("llm-tab:sign-in-method:codex:subscription");
    const apiKey = screen.getByTestId("llm-tab:sign-in-method:codex:api");
    expect(screen.getByRole("radiogroup", { name: "How do you want to sign in?" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "ChatGPT subscription" })).toBe(subscription);
    expect(screen.getByRole("radio", { name: "API key" })).toBe(apiKey);
    expect(subscription).toHaveAttribute("aria-checked", "false");
    expect(apiKey).toHaveAttribute("aria-checked", "false");

    fireEvent.click(apiKey);
    expect(onChange).toHaveBeenLastCalledWith("api");
    rerender(<SignInMethodChoice rowId="codex" planName="ChatGPT" value="api" onChange={onChange} />);
    expect(apiKey).toHaveAttribute("aria-checked", "true");
    expect(subscription).toHaveAttribute("aria-checked", "false");
    // Both options are buttons in one radio group, so Tab reaches the group and the arrow keys move between them (driven with
    // real key events in the CDP check; jsdom does not run Radix's roving focus).
    expect(subscription.tagName).toBe("BUTTON");
    expect(apiKey.tagName).toBe("BUTTON");
  });

  it("names the plan by the provider's brand", () => {
    render(<SignInMethodChoice rowId="claude" planName="Claude" value="subscription" onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Claude subscription" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("subscription account and credential disclosure", () => {
  it("discloses the account and the installed CLI credential boundary", () => {
    const claude: SubscriptionProviderView = {
      descriptor: { id: "claude-code", label: "Claude Code", planName: "Claude", cliName: "Claude Code CLI", executable: "discovered", description: "", loginMethods: ["browser"], supportsLogout: true },
      status: { runtime: "ready", connection: "connected", models: [], capabilities: runtimeCapabilities() },
    };
    renderProviders([claude, connectedCodex()], {});
    expect(screen.getByTestId("subscription-provider:claude-code:billing-disclosure")).toHaveTextContent(
      "Uses your own Claude subscription through the sign-in tool on this computer; Ave never sees or stores your Claude credentials.",
    );
    // Only the runtime reached through the user's own CLI carries it.
    expect(screen.queryByTestId("subscription-provider:codex:billing-disclosure")).toBeNull();
  });
});

describe("SubscriptionAuthControls for ChatGPT plan usage", () => {
  const planView = (status: SubscriptionProviderStatus): SubscriptionProviderView => {
    const descriptor = subscriptionRuntimeDescriptor("chatgpt-plan");
    return {
      descriptor: {
        id: "chatgpt-plan",
        label: descriptor.label,
        planName: descriptor.planName,
        cliName: descriptor.cliName,
        executable: descriptor.executable,
        description: "",
        loginMethods: descriptor.loginMethods,
        supportsLogout: descriptor.supportsManagedLogout,
      },
      status,
    };
  };

  it("offers Continue with ChatGPT and explains plan billing, with no runtime picker", () => {
    const beginLogin = vi.fn();
    renderProviders([planView({ runtime: "ready", connection: "signed-out" })], {
      beginLogin,
      configureRuntime: vi.fn(),
      forgetRuntime: vi.fn(),
    });
    const login = screen.getByTestId("subscription-provider:chatgpt-plan:login-browser");
    expect(login).toHaveTextContent("Continue with ChatGPT");
    expect(screen.queryByTestId("subscription-provider:chatgpt-plan:login-device-code")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subscription-provider:chatgpt-plan:configure-runtime")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subscription-provider:chatgpt-plan:change-runtime")).not.toBeInTheDocument();
    expect(screen.getByTestId("subscription-provider:chatgpt-plan:billing-disclosure")).toHaveTextContent(/separate from API-key charges/);
    fireEvent.click(login);
    expect(beginLogin).toHaveBeenCalledWith("chatgpt-plan", "browser");
  });

  it("shows the plan in use with Manage usage once signed in", () => {
    const manageUsage = vi.fn();
    const logout = vi.fn();
    renderProviders([planView({ runtime: "ready", connection: "connected", capabilities: runtimeCapabilities({ images: false }) })], {
      manageUsage,
      logout,
    });
    expect(screen.getByTestId("subscription-provider:chatgpt-plan:plan-in-use")).toHaveTextContent("Using ChatGPT plan");
    fireEvent.click(screen.getByTestId("subscription-provider:chatgpt-plan:manage-usage"));
    expect(manageUsage).toHaveBeenCalledWith("chatgpt-plan");
    fireEvent.click(screen.getByTestId("subscription-provider:chatgpt-plan:logout"));
    expect(logout).toHaveBeenCalledWith("chatgpt-plan");
  });

  it("welcomes the first plan sign-in once, and Got it dismisses it", () => {
    const acknowledgeNotice = vi.fn();
    renderProviders([planView({
      runtime: "ready", connection: "connected", capabilities: runtimeCapabilities({ images: false }), notice: "welcome",
    })], { acknowledgeNotice });
    const dialog = screen.getByTestId("subscription-provider:chatgpt-plan:welcome");
    expect(dialog).toHaveTextContent("You're using your ChatGPT plan");
    fireEvent.click(screen.getByTestId("subscription-provider:chatgpt-plan:welcome-got-it"));
    expect(acknowledgeNotice).toHaveBeenCalledWith("chatgpt-plan");
  });

  it.each([
    ["revocation-unconfirmed", /disconnect Ave in ChatGPT settings/],
    ["reconnect-required", /sign in again/],
    ["plan-usage-disabled", /allow plan usage/],
    ["declined", /not allowed in the browser/],
    ["account-mismatch", /different ChatGPT account or workspace/],
    ["state-mismatch", /did not belong to this attempt/],
  ] as const)("explains the %s notice and lets it be dismissed", (notice, text) => {
    const acknowledgeNotice = vi.fn();
    renderProviders([planView({ runtime: "ready", connection: "signed-out", notice })], { acknowledgeNotice, beginLogin: vi.fn() });
    expect(screen.getByTestId("subscription-provider:chatgpt-plan:notice")).toHaveTextContent(text);
    fireEvent.click(screen.getByTestId("subscription-provider:chatgpt-plan:notice-dismiss"));
    expect(acknowledgeNotice).toHaveBeenCalledWith("chatgpt-plan");
  });

  it("says plainly when plan sign-in is not configured", () => {
    renderProviders([planView({ runtime: "not-configured", connection: "unknown" })], { beginLogin: vi.fn() });
    expect(screen.getByTestId("subscription-provider:chatgpt-plan:not-configured")).toBeInTheDocument();
    expect(screen.queryByTestId("subscription-provider:chatgpt-plan:login-browser")).not.toBeInTheDocument();
  });
});
