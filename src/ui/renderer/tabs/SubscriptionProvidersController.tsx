import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SUBSCRIPTION_RUNTIME_DESCRIPTORS,
  subscriptionRuntimeDescriptor,
  type ActiveChatRuntime,
  type SubscriptionRuntimeActionResult,
  type SubscriptionRuntimeErrorCode,
  type SubscriptionRuntimeId,
  type SubscriptionRuntimeModelsResult,
  type SubscriptionRuntimeStatus,
} from "../../../shared/subscription-runtime.js";
import type { AppSettings, AveApi } from "../types.js";
import {
  type SubscriptionProvidersSectionProps,
  type SubscriptionBusyAction,
  type SubscriptionChatSelection,
  type SubscriptionProviderModel,
  type SubscriptionProviderStatus,
  type SubscriptionProviderView,
} from "./SubscriptionProvidersSection.js";

type ProviderState = {
  readonly status: SubscriptionRuntimeStatus | null;
  readonly models: readonly SubscriptionProviderModel[];
  readonly errorCode: SubscriptionRuntimeErrorCode | null;
  readonly busyAction: SubscriptionBusyAction | null;
  /** A read-only status probe is in flight. It must never replace a mutation's busy state. */
  readonly statusRefreshPending: boolean;
};

type ProviderStateMap = Record<SubscriptionRuntimeId, ProviderState>;

const PROVIDER_IDS = SUBSCRIPTION_RUNTIME_DESCRIPTORS.map((descriptor) => descriptor.id);

function initialProviderStates(): ProviderStateMap {
  const initialState = (): ProviderState => ({
    status: null,
    models: [],
    errorCode: null,
    busyAction: null,
    statusRefreshPending: false,
  });
  return SUBSCRIPTION_RUNTIME_DESCRIPTORS.reduce<ProviderStateMap>(
    (states, descriptor) => {
      states[descriptor.id] = initialState();
      return states;
    },
    {} as ProviderStateMap,
  );
}

function initialProviderRevisionMap(): Record<SubscriptionRuntimeId, number> {
  return SUBSCRIPTION_RUNTIME_DESCRIPTORS.reduce<Record<SubscriptionRuntimeId, number>>(
    (revisions, descriptor) => {
      revisions[descriptor.id] = 0;
      return revisions;
    },
    {} as Record<SubscriptionRuntimeId, number>,
  );
}

function initialProviderFlagMap(): Record<SubscriptionRuntimeId, boolean> {
  return SUBSCRIPTION_RUNTIME_DESCRIPTORS.reduce<Record<SubscriptionRuntimeId, boolean>>(
    (flags, descriptor) => {
      flags[descriptor.id] = false;
      return flags;
    },
    {} as Record<SubscriptionRuntimeId, boolean>,
  );
}

function safeFailure(): SubscriptionRuntimeActionResult {
  return { ok: false, error: "subscription-operation-failed" };
}

function safeModelsFailure(): SubscriptionRuntimeModelsResult {
  return { ok: false, error: "subscription-operation-failed" };
}

function activeRuntimeFromSettings(settings: AppSettings): ActiveChatRuntime {
  return settings.llm.activeChatRuntime ?? { kind: "api" };
}

function sameActiveRuntime(left: ActiveChatRuntime, right: ActiveChatRuntime): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "api" || (
    right.kind === "subscription"
    && left.provider === right.provider
    && left.model === right.model
  );
}

function projectStatus(
  state: ProviderState,
): SubscriptionProviderStatus | undefined {
  const status = state.status;
  if (!status) {
    // Failed actions and reads may have no status payload. Keep their safe error visible without retaining stale connection or
    // chat capabilities.
    return state.errorCode
      ? { runtime: "unavailable", connection: "unknown", errorCode: state.errorCode }
      : undefined;
  }
  return {
    runtime: status.runtime,
    connection: status.connection,
    pendingDeviceCode: status.pendingDeviceCode,
    pendingLoginMethod: status.pendingLogin,
    canOpenLoginBrowser: status.canOpenVerificationUrl,
    models: state.models,
    capabilities: status.capabilities,
    version: status.version,
    errorCode: state.errorCode,
    ...(status.notice ? { notice: status.notice } : {}),
  };
}

/** Renderer-only controller for every subscription runtime. It contains no credentials, executable paths, or URLs: those
 * stay in the main process and are represented only by the common safe status projection. */
/** Expose subscription state beside API state so one model chooser can consume both. */
export function useSubscriptionProviders(api: AveApi) {
  const [states, setStates] = useState<ProviderStateMap>(initialProviderStates);
  const [activeRuntime, setActiveRuntime] = useState<ActiveChatRuntime>({ kind: "api" });
  const [apiChatBusy, setApiChatBusy] = useState(false);
  const [apiChatError, setApiChatError] = useState<SubscriptionRuntimeErrorCode | null>(null);
  const [chatSelectionBusy, setChatSelectionBusy] = useState(false);
  const settingsRevisionRef = useRef(0);
  const statusRevisionByProviderRef = useRef(initialProviderRevisionMap());
  const mutationRevisionByProviderRef = useRef(initialProviderRevisionMap());
  const activeMutationRevisionByProviderRef = useRef(initialProviderRevisionMap());
  /** Which providers have had their catalogue asked for since they connected. */
  const modelsRequestedByProviderRef = useRef(initialProviderFlagMap());
  const activeRuntimeRef = useRef<ActiveChatRuntime>({ kind: "api" });
  const chatSelectionBusyRef = useRef(false);

  const applySettings = useCallback((settings: AppSettings) => {
    const nextRuntime = activeRuntimeFromSettings(settings);
    const runtimeChanged = !sameActiveRuntime(activeRuntimeRef.current, nextRuntime);
    activeRuntimeRef.current = nextRuntime;
    setActiveRuntime(nextRuntime);
    if (runtimeChanged) setApiChatError(null);
  }, []);

  const refreshSettings = useCallback(async () => {
    const revision = ++settingsRevisionRef.current;
    try {
      const settings = await api.getSettings();
      if (revision !== settingsRevisionRef.current) return;
      applySettings(settings);
    } catch {
      // A settings refresh never turns an already safe subscription state into a permissive one. The main-owned status action
      // remains authoritative.
    }
  }, [api, applySettings]);

  const refreshStatus = useCallback(async (provider: SubscriptionRuntimeId, options?: { refresh: true }) => {
    const revision = ++statusRevisionByProviderRef.current[provider];
    setStates((current) => ({
      ...current,
      [provider]: { ...current[provider], statusRefreshPending: true, errorCode: null },
    }));
    let result: SubscriptionRuntimeActionResult;
    try {
      result = await (options ? api.subscriptionRuntimeStatus(provider, options) : api.subscriptionRuntimeStatus(provider));
    } catch {
      result = safeFailure();
    }
    setStates((current) => {
      if (statusRevisionByProviderRef.current[provider] !== revision) return current;
      return {
        ...current,
        [provider]: {
          ...current[provider],
          ...(result.status
            ? { status: result.status }
            : !result.ok ? { status: null } : {}),
          errorCode: result.ok ? null : result.error,
          statusRefreshPending: false,
        },
      };
    });
  }, [api]);

  const runAction = useCallback(async (
    provider: SubscriptionRuntimeId,
    busyAction: SubscriptionBusyAction,
    operation: () => Promise<SubscriptionRuntimeActionResult>,
  ): Promise<SubscriptionRuntimeActionResult> => {
    if (activeMutationRevisionByProviderRef.current[provider] !== 0) {
      return safeFailure();
    }
    const mutationRevision = ++mutationRevisionByProviderRef.current[provider];
    activeMutationRevisionByProviderRef.current[provider] = mutationRevision;
    // Supersede any status read that predates the mutation. Its response is no longer a trustworthy projection after login,
    // logout, or reconfiguration.
    const statusRevision = ++statusRevisionByProviderRef.current[provider];
    setStates((current) => ({
      ...current,
      [provider]: { ...current[provider], busyAction, errorCode: null },
    }));
    let result: SubscriptionRuntimeActionResult;
    try {
      result = await operation();
    } catch {
      result = safeFailure();
    }
    if (activeMutationRevisionByProviderRef.current[provider] !== mutationRevision) return result;
    activeMutationRevisionByProviderRef.current[provider] = 0;
    setStates((current) => {
      if (mutationRevisionByProviderRef.current[provider] !== mutationRevision) return current;
      const statusCurrent = statusRevisionByProviderRef.current[provider] === statusRevision;
      return {
        ...current,
        [provider]: {
          ...current[provider],
          ...(statusCurrent && result.status
            ? { status: result.status }
            : statusCurrent && !result.ok ? { status: null } : {}),
          errorCode: result.ok ? null : result.error,
          busyAction: null,
          ...(statusCurrent ? { statusRefreshPending: false } : {}),
        },
      };
    });
    if (mutationRevisionByProviderRef.current[provider] !== mutationRevision) return result;
    const refreshRevision = statusRevisionByProviderRef.current[provider] + 1;
    await refreshStatus(provider);
    if (
      !result.ok
      && mutationRevisionByProviderRef.current[provider] === mutationRevision
      && statusRevisionByProviderRef.current[provider] === refreshRevision
    ) {
      setStates((current) => ({
        ...current,
        [provider]: { ...current[provider], errorCode: result.error },
      }));
    }
    await refreshSettings();
    return result;
  }, [refreshSettings, refreshStatus]);

  const runChatSelection = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    // The main process provides authoritative request-start ordering across windows. This renderer gate prevents a single
    // settings surface from issuing conflicting API/provider selections before it has painted the first action as busy.
    if (chatSelectionBusyRef.current) return;
    chatSelectionBusyRef.current = true;
    setChatSelectionBusy(true);
    setApiChatError(null);
    try {
      await operation();
    } finally {
      chatSelectionBusyRef.current = false;
      setChatSelectionBusy(false);
    }
  }, []);

  const loadModels = useCallback(async (provider: SubscriptionRuntimeId) => {
    if (activeMutationRevisionByProviderRef.current[provider] !== 0) return;
    const mutationRevision = ++mutationRevisionByProviderRef.current[provider];
    activeMutationRevisionByProviderRef.current[provider] = mutationRevision;
    // The status bundled with model discovery is authoritative only until a newer status action/event starts. It also
    // invalidates an older read.
    const statusRevision = ++statusRevisionByProviderRef.current[provider];
    setStates((current) => ({
      ...current,
      [provider]: { ...current[provider], busyAction: "load-models", errorCode: null },
    }));
    let result: SubscriptionRuntimeModelsResult;
    try {
      result = await api.subscriptionListModels(provider);
    } catch {
      result = safeModelsFailure();
    }
    if (activeMutationRevisionByProviderRef.current[provider] !== mutationRevision) return;
    activeMutationRevisionByProviderRef.current[provider] = 0;
    setStates((current) => {
      const previous = current[provider];
      if (mutationRevisionByProviderRef.current[provider] !== mutationRevision) return current;
      if (statusRevisionByProviderRef.current[provider] !== statusRevision) {
        return {
          ...current,
          [provider]: { ...previous, busyAction: null },
        };
      }
      if (!result.ok) {
        return {
          ...current,
          [provider]: {
            ...previous,
            ...(result.status ? { status: result.status } : {}),
            errorCode: result.error,
            busyAction: null,
            statusRefreshPending: false,
          },
        };
      }
      const models = result.models.map((model) => ({
        id: model.id,
        label: model.displayName,
        isDefault: model.isDefault,
      }));
      return {
        ...current,
        [provider]: {
          ...previous,
          status: result.status,
          models,
          errorCode: null,
          busyAction: null,
          statusRefreshPending: false,
        },
      };
    });
  }, [api]);

  useEffect(() => {
    const unsubscribe = api.onSettingsUpdated((settings) => {
      settingsRevisionRef.current += 1;
      applySettings(settings);
    });
    void refreshSettings();
    for (const provider of PROVIDER_IDS) void refreshStatus(provider);
    return unsubscribe;
  }, [api, applySettings, refreshSettings, refreshStatus]);

  useEffect(() => api.onSubscriptionRuntimeStatusUpdated(({ provider }) => {
    // A different settings window or an external completion changed a safe status projection. Refresh only that provider card.
    void refreshStatus(provider);
  }), [api, refreshStatus]);

  /** Fetch subscription catalogs once per reachable connection, including empty results; disconnect clears the marker so
   * reconnect fetches again. */
  useEffect(() => {
    for (const provider of PROVIDER_IDS) {
      const connected = states[provider].status?.connection === "connected";
      if (!connected) {
        modelsRequestedByProviderRef.current[provider] = false;
        continue;
      }
      if (modelsRequestedByProviderRef.current[provider]) continue;
      if (!subscriptionRuntimeDescriptor(provider).supportsModelSelection) continue;
      modelsRequestedByProviderRef.current[provider] = true;
      void loadModels(provider);
    }
  }, [loadModels, states]);

  useEffect(() => {
    const pendingProviders = PROVIDER_IDS.filter((provider) =>
      states[provider].status?.connection === "pending",
    );
    if (pendingProviders.length === 0) return undefined;
    const timer = window.setInterval(() => {
      for (const provider of pendingProviders) void refreshStatus(provider);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus, states]);

  const providers = useMemo<SubscriptionProviderView[]>(() =>
    SUBSCRIPTION_RUNTIME_DESCRIPTORS.map((descriptor) => ({
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
      status: projectStatus(states[descriptor.id]),
      busyAction: states[descriptor.id].busyAction,
      refreshPending: states[descriptor.id].statusRefreshPending,
    })),
  [states]);

  const activeSelection: SubscriptionChatSelection | null = activeRuntime.kind === "subscription"
    ? { providerId: activeRuntime.provider, modelId: activeRuntime.model ?? null }
    : null;

  const props: SubscriptionProvidersSectionProps = {
  providers,
  activeSelection,
  apiChatActive: activeRuntime.kind === "api",
  apiChatBusy,
  chatSelectionBusy,
  apiChatError,
  actions: {
    // The user's "check again" bypasses main's settled-status cache.
    refreshStatus: (provider) => refreshStatus(provider, { refresh: true }),
    configureRuntime: async (provider) => {
      await runAction(
        provider,
        "configure-runtime",
        () => api.subscriptionChooseRuntime(provider),
      );
    },
    forgetRuntime: async (provider) => {
      await runAction(
        provider,
        "forget-runtime",
        () => api.subscriptionForgetRuntime(provider),
      );
    },
    verifyRuntime: async (provider) => {
      await runAction(
        provider,
        "verify-runtime",
        () => api.subscriptionVerifyRuntime(provider),
      );
    },
    beginLogin: async (provider, method) => {
      await runAction(
        provider,
        method === "browser" ? "login-browser" : "login-device-code",
        () => api.subscriptionStartLogin(provider, method),
      );
    },
    openLoginBrowser: async (provider) => {
      await runAction(
        provider,
        "open-login-browser",
        () => api.subscriptionOpenLoginBrowser(provider),
      );
    },
    cancelLogin: async (provider) => {
      await runAction(
        provider,
        "cancel-login",
        () => api.subscriptionCancelLogin(provider),
      );
    },
    logout: async (provider) => {
      await runAction(
        provider,
        "logout",
        () => api.subscriptionLogout(provider),
      );
    },
    useForChat: async (provider, modelId) => {
      await runChatSelection(async () => {
        const result = await runAction(
          provider,
          "use-for-chat",
          () => api.subscriptionUseForChat(provider, modelId ?? undefined),
        );
        if (result.ok) await refreshSettings();
      });
    },
    acknowledgeNotice: async (provider) => {
      await runAction(
        provider,
        "acknowledge-notice",
        () => api.subscriptionAcknowledgeNotice(provider),
      );
    },
    manageUsage: async (provider) => {
      const url = subscriptionRuntimeDescriptor(provider).usageSettingsUrl;
      if (url) await api.openExternalUrl(url);
    },
    useApiForChat: async () => {
      await runChatSelection(async () => {
        setApiChatBusy(true);
        try {
          const result = await api.subscriptionUseApiForChat();
          if (!result.ok) setApiChatError(result.error);
          else await refreshSettings();
        } catch {
          setApiChatError("subscription-operation-failed");
        } finally {
          setApiChatBusy(false);
        }
      });
    },
  },
  };

  return { providers, activeRuntime, props };
}
