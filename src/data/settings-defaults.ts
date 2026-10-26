import {
  DEFAULT_CORP_CA_COMMON_NAME,
} from "../shared/corp-ca-common-name.js";
import { SUBAGENT_MAX_ROUNDS_DEFAULT } from "../shared/subagent-policy.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
  SIDEBAR_DEFAULT_WIDTH,
  FILE_TREE_DEFAULT_WIDTH,
} from "../shared/side-panel.js";
import {
  DEFAULT_LLM_VENDOR,
  freshVendorBlocks,
} from "../shared/llm-vendor-defaults.js";
import { DEFAULT_BUNDLE_ID } from "../shared/theme-bundles.js";
import { DEFAULT_LOCALE } from "../i18n/index.js";
import { DEFAULT_APP_MODE } from "../shared/initial-app-mode.js";
import { DEFAULT_PROCESSING_DISPLAY_LEVEL } from "../shared/processing-display-level.js";
import { DEFAULT_SIDEBAR_TAB } from "../shared/sidebar-tab.js";
import { normalizeSettingsTab } from "../shared/settings-tabs.js";
import { LOG_RETENTION_DAYS } from "../shared/log-retention.js";
import { DEFAULT_UPSTREAM_PROXY } from "../shared/upstream-proxy.js";
import { DEFAULT_SUBSCRIPTION_REASONING_SPEED } from "../shared/subscription-runtime.js";
import type { AppSettings } from "./settings-store.js";

export const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    compactionModel: "",
    compactionModelRoute: "",
    activeChatRuntime: { kind: "api" },
    provider: DEFAULT_LLM_VENDOR,
    vendors: freshVendorBlocks(),
    streamSmoothing: "none",
    fallbackChain: [],
    modelListCache: {},
    pricingOverrides: [],
    pinnedModels: [],
    modelCatalogRefresh: "auto",
    subscriptionReasoningSpeed: DEFAULT_SUBSCRIPTION_REASONING_SPEED,
  },
  chat: {
    systemPrompt:
      "You are Ave, an agent that works beside the user across the web, the terminal, and their files. You provide accurate, helpful answers grounded in the user's documents and context. Respond in the user's language.",
    autoCompact: true,
    processingDisplayLevel: DEFAULT_PROCESSING_DISPLAY_LEVEL,
    // Tool rounds a sub-agent may run before it hits `round-cap` and suspends. Run as configured; no ceiling narrows it. Exposed because the right budget depends on the
    // work: a deep multi-repo review needs far more rounds than a single-file lookup, and guessing wrong shows up as an agent that stops mid-investigation with partial output.
    subAgentMaxRounds: SUBAGENT_MAX_ROUNDS_DEFAULT,
    // Assistant rounds between host progress notifications inside one turn. Ten is short enough that a run which stopped converging is told so
    // while it still has budget to change approach, and long enough that a normal three-or-four-round turn never sees one. `0` turns them off.
    progressNudgeRounds: 10,
  },
  a2aRemote: {
    routeControlBaseUrl: "",
    receiverPublicOrigin: "",
    outboundCallerGenerationId: "",
    receiverCallerGenerationId: "",
    extensionSpecDigestSha256: "",
    targets: [],
    receiverMaxKeysPerGeneration: 100,
  },
  webSearch: {
    provider: "duckduckgo",
  },
  marketplace: {
    // No catalog URL or API key: packages come from git marketplaces (src/marketplace/), whose sources live in ~/.ave/marketplaces/.
    installedProviderIds: [],
    installedProviderPresets: [],
    installedThemeBundleIds: [],
    installedLanguagePacks: [],
    installedMessagingConnections: [],
    // Both default ON, which is what the pre-setting env-only resolvers did when their variables were unset; i.e. on every packaged install.
    updateCheckEnabled: true,
    offlineCacheEnabled: true,
  },
  routine: {},
  homeDocs: {
    // Off is the pre-existing behavior: a packaged update is offered as an upgrade marker and the user's live doc is never moved unprompted.
    keepLatest: false,
  },
  privacy: {
    piiRedactEnabled: false,
  },
  updates: {
    autoCheckEnabled: true,
  },
  telemetry: {
    enabled: false,
    crashReportingEnabled: false,
  },
  audit: {
    auditRotationMaxBytes: 10 * 1024 * 1024, // 10 MB
    auditRetentionDays: 30,
  },
  // Owner decision 2026-10-20: the sandbox egress proxy follows the environment and the OS proxy settings unless Settings says otherwise.
  upstreamProxy: { ...DEFAULT_UPSTREAM_PROXY },
  diagnostics: {
    // Raw crash-dump binaries excluded by default; metadata-only in the bundle.
    includeCrashDumps: false,
    // From the fs-free retention SOT (src/shared/log-retention.ts), the same constant log-file-sink
    // re-exports as LOG_RETENTION_DAYS; one literal, no drift between the boot-time prune window and this default.
    logRetentionDays: LOG_RETENTION_DAYS,
  },
  appearance: {
    schemaVersion: 2,
    bundleId: DEFAULT_BUNDLE_ID,
    language: DEFAULT_LOCALE,
  },
  documents: { openMode: "direct" },
  webView: {
    preferredFlow: "in-app",
  },
  system: {
    turnCompletionSoundEnabled: true,
    closeBehavior: "hide-to-tray",
    appMode: DEFAULT_APP_MODE,
    // Opt-in loopback API server; OFF by default (also enabled by env AVE_LOCAL_API=1). #1409/#1436.
    localApiServer: false,
    // Staged by platform, matching the pre-setting behaviour exactly: the GPU process is what crashes on restricted Windows/Linux corp+VDI
    // drivers, and macOS has never shown that failure. The setting exists so a user whose machine is fine is not stuck with the safe default forever.
    hardwareAcceleration: process.platform !== "win32" && process.platform !== "linux",
    // The corporate CA pipeline stays on by default -- it was on before it had a setting, and on a machine with no such CA it costs one keychain query that finds nothing. The name
    // is a placeholder that an organization is expected to replace: on a machine whose CA is named anything else the lookup finds nothing, which costs one query and changes nothing.
    corpCaEnabled: true,
    corpCaCommonName: DEFAULT_CORP_CA_COMMON_NAME,
    corpCaDebugLog: false,
    // The quit-time cleanup window, from the timeout policy that already owns the number. Stated here so
    // the control has something concrete to render and to persist when the user picks the default back.
    shutdownCleanupTimeoutMs: TOOL_TIMEOUT_POLICY.shutdownCleanupMs,
    sidePanelWidth: SIDE_PANEL_DEFAULT_WIDTH,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    sidePanelFileTreeWidth: FILE_TREE_DEFAULT_WIDTH,
    sidePanelSplitPreviewPercent: SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
    sidePanelSplitSubagentPercent: SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
    sidebarActiveTab: DEFAULT_SIDEBAR_TAB,
    // `home` is the only built-in that is inline-only and always present.
    activeView: "home",
    // Ask the normalizer what an absent tab means rather than restating it.
    settingsTab: normalizeSettingsTab(undefined),
    pinnedProjectRoots: [],
    archivedProjectRoots: [],
    projectLabels: {},
    // E4; auto-launch defaults OFF (opt-in). Only applied on packaged builds.
    launchAtStartup: false,
    launchMinimized: false,
  },
  // E4; global shortcuts default OFF with no accelerator chosen.
  shortcuts: {
    toggleWindow: null,
    enabled: false,
  },
  plugins: {},
  pluginConfigs: {},
  alerts: {
    // The master switch is on; every kind is opt-in on its own row, so this alone notifies nothing.
    osNotificationsEnabled: true,
    kinds: {},
  },
  retiredPluginConfigs: {},
  features: {
    // Profile changes affect every future prompt, so background refresh is explicit opt-in.
    idlePreferenceRefresh: false,
    // Derived long-term overviews send eligible active notes to the configured model only on opt-in.
    idleMemoryConsolidation: false,
    // Existing installs do not start a new provider-backed capture path until the user chooses review or auto in Settings.
    memoryCaptureMode: "off",
    // Wake delivers background results through the normal parent turn and its fail-closed prompt gate; mailbox-only delivery waits for another user turn.
    subAgentAutonomousWake: true,
    // A child ask that the automatic reviewer left at `ask` goes to the child's own parent agent before it goes to the user. Ships ON: the parent wrote the child's task and is the only party besides the user who knows whether a given call serves it, and a user who
    // delegated the work did not ask to arbitrate each step of it. The lane can only narrow to a ONE-SHOT allow, under a host-enforced verdict ceiling, after every hard check in the approval gate; and anything it cannot decide still becomes the same user modal as before.
    subAgentParentAdjudication: true,
    // External A2A wire routes are independently opt-in and default OFF.
    a2aLoopbackServer: false,
    a2aRemoteRouting: false,
    a2aRemoteReceiver: false,

    // Fresh installs may start the optional first-boot tour. Persisting an explicit `false` (instead of relying on `undefined`) keeps the contract obvious: the flag flips to `true` exactly once, from
    // `markOnboardingCompleted` after the user finishes (or skips) the chain. Any other path that wants to suppress the chain must set this to `true` deliberately; no "missing key === skipped" trap.
    onboardingCompleted: false,
    // Permission policy host-classifies-risk migration gate. Ships ON; the host derives the effective category from host-owned signals (foreground plugin
    // read-relaxation included) instead of trusting the plugin-declared category. Shadow mode reconciliation completed before this flip; users can still opt out in Settings.
    hostClassifiesRisk: true,
    // Request OS confinement by default where the host shell has a supported isolation backend. Windows remains explicitly gated off until its shell isolation is ready.
    // Stored user values override this default. Settings activation degrades visibly when unavailable; explicit AVE_SANDBOX_ENABLED=1 activation stays fail-closed on macOS/Linux.
    osToolSandbox: process.platform === "darwin" || process.platform === "linux",
    // Plugin-worker confinement: plugin workers, out-of-process plugin children, plugin script hooks and external MCP stdio servers run under ASRT exactly when this is on, whatever the shell sandbox above says. Its own setting (owner
    // 2026-10-16) so that the shell sandbox default can be on without confining workers whose manifests under-declare the domains they reach. OFF everywhere; `loadSettings` derives it from a stored `osToolSandbox: true` when a file predates the split.
    pluginWorkerConfinement: false,
    // Shell egress asks: a sandboxed shell's connection to a host no grant covers asks the person (denied when
    // nobody can answer). Off denies such connections outright. On with the proxy-egress ask (design B, PR 4).
    shellEgressAsk: true,
  },
};
