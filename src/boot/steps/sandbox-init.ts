



import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";
import type { SandboxGateAction, SandboxGateReason } from "./sandbox-gate.js";
import {
  canRetryWindowsAsProxyOnly,
  mxcShellCapability,
  planWindowsSandbox,
  windowsProxyOnlyCapability,
  windowsSubstrateFor,
  windowsSubstrateWithoutAsrt,
  type WindowsSandboxPlanInputs,
} from "./windows-sandbox-plan.js";
import type { SandboxStartFailureCause } from "../../shared/sandbox-capability-info.js";
import { classifySandboxDependencyErrors } from "../../permissions/sandbox-start-failure.js";
import { errorMessage } from "../../shared/error-message.js";
import { checkSandboxSweepRoot } from "../../shared/ave-home-test-guard.js";
import { removeOwnedPluginTree } from "../../plugins/installed-entry-fs.js";
import { getAveHomePrivacyFailure, setAveHomePrivacyRefusalReporter } from "../../shared/ave-home.js";

const log = createLogger("ave");

export async function initSandboxGate(ctx: BootContext): Promise<void> {
  const { settingsService, bootAuditLogger, buildWorkerEgressAllowlists } = ctx;
  setAveHomePrivacyRefusalReporter((message) => {
    log.warn(message);
    bootAuditLogger.log({ timestamp: new Date().toISOString(), sessionId: "extensions", type: "error",
      output: `[ave_home_privacy_refused] ${message}` });
  });

  // Platform policy (ALL platforms share the SAME gate — there is no separate
  // Windows opt-in):
  //   - macOS / Linux: initialize ASRT when the gate is on and deps are present.
  //     If the gate is on but `checkDependencies()` reports errors (Linux: bwrap
  //     / socat / ripgrep missing) the branch depends on the on-signal: the
  //     EXPLICIT env opt-in FAIL-CLOSES (THROW, no unsandboxed plain spawn —
  //     no-fallback rule), while the DEFAULT/settings-on path DEGRADES gracefully
  //     (loud warn + unsandboxed, non-bricking). A throw on the staged default
  //     path would brick hosts before they can repair missing deps.
  //   - Windows (srt-win.exe): filesystem + network sandbox (dedicated
  //     `srt-sandbox` user ACL backend + WFP; no process isolation). srt-win is
  //     BUNDLED (asarUnpack vendor/**), so there is no download — but it needs a
  //     one-time UAC install before the sandbox user and WFP filter set are ready.
  //     Windows does NOT hard-throw on deps-missing: a throw would BRICK the
  //     first run (the user cannot complete the install before boot even
  //     reaches the prompt). Instead we keep `isAsrtSandboxActive()` FALSE (host
  //     shell tools run UNSANDBOXED — isolation=none) and emit a LOUD signal so
  //     the gap is visible. When win32 IS ready → initialize ASRT normally and
  //     publish a PARTIAL capability (filesystem + network, process=false).
  {
    const {
      initializeAsrtSandbox,
      subscribeAsrtViolations,
      appOwnedSandboxHomeRoot,
      ensureSandboxPrivateRoot,
      useAppOwnedSandboxTempRoot,
      checkAsrtDependencies,
      isAsrtLinuxRuntimeProbeError,
      closeAllEgressConnections,
    } = await import("../../permissions/asrt-sandbox.js");
    const {
      setActiveSandboxCapability,
      setShellSandboxRequestedAtBoot,
      setPluginWorkerConfinementRequestedAtBoot,
      setSandboxBootOutcome,
      detectSandboxCapability,
      setWindowsSandboxSubstrate,
      getWindowsSandboxSubstrate,
    } = await import("../../permissions/sandbox-capability.js");
    const { sandboxConfinementForPlatform } = await import(
      "../../shared/sandbox-capability-info.js"
    );
    const { decideSandboxGate, shouldWarnHostClassifyInterlock } = await import(
      "./sandbox-gate.js"
    );

    // Two scopes, each with two independent on-signals. The shell sandbox
    // (`features.osToolSandbox` / AVE_SANDBOX_ENABLED=1) confines host shells;
    // plugin-worker confinement (`features.pluginWorkerConfinement` /
    // AVE_PLUGIN_WORKER_CONFINEMENT=1) confines plugin workers, plugin
    // children, plugin hooks and MCP stdio servers. Neither scope's signals
    // decide the other. ASRT itself is one runtime, initialized when either
    // scope asks for it. `explicitEnv` is the deliberate "I really mean it"
    // override; `settingOn` is a Settings toggle (off by default). The
    // DISTINCTION drives degrade-vs-abort: see decideSandboxGate.
    const features = settingsService.get("features");
    const shellExplicitEnv = process.env["AVE_SANDBOX_ENABLED"] === "1";
    const workerExplicitEnv = process.env["AVE_PLUGIN_WORKER_CONFINEMENT"] === "1";
    const shellRequested = (features?.osToolSandbox ?? false) || shellExplicitEnv;
    const workerRequested = (features?.pluginWorkerConfinement ?? false) || workerExplicitEnv;
    const explicitEnv = shellExplicitEnv || workerExplicitEnv;
    const settingOn = (features?.osToolSandbox ?? false) || (features?.pluginWorkerConfinement ?? false);
    const sandboxOptIn = shellRequested || workerRequested;
    // Seal request intent once for this process, per scope. Execution paths
    // must not re-read the mutable settings UI: requested-on-but-degraded is
    // security relevant for the host-shell plan, and a worker spawn must not
    // follow a toggle flipped after boot.
    setShellSandboxRequestedAtBoot(shellRequested);
    setPluginWorkerConfinementRequestedAtBoot(workerRequested);
    // The variables that made this boot an explicit (fail-closed) opt-in, for
    // the abort messages below.
    const explicitEnvNames = [
      ...(shellExplicitEnv ? ["AVE_SANDBOX_ENABLED"] : []),
      ...(workerExplicitEnv ? ["AVE_PLUGIN_WORKER_CONFINEMENT"] : []),
    ];
    const explicitEnvLabel = explicitEnvNames.map((name) => `${name}=1`).join(" and ");
    // Before the split AVE_SANDBOX_ENABLED=1 alone also confined extension
    // processes. A launcher that still relies on that now gets shells only, so
    // say so loudly rather than leave workers unconfined in silence.
    if (shellExplicitEnv && !workerRequested) {
      log.warn(
        "boot: AVE_SANDBOX_ENABLED=1 now confines host shells only — plugin workers, plugin children, " +
          "plugin hooks and MCP stdio servers run WITHOUT OS confinement this session. " +
          "Set AVE_PLUGIN_WORKER_CONFINEMENT=1 (or turn on Settings → Permissions 'Extension confinement') " +
          "to confine them as before.",
      );
    }

    // Activation telemetry — which on-signal drove the gate. ONE event per boot
    // is emitted (below) at the terminal outcome so real-world activate/degrade/
    // abort/skip rates can be read per platform. explicit-env takes precedence
    // (it is the fail-closed signal); else the settings flag; else off.
    const sandboxGateOnSignal: "explicit-env" | "default-settings" | "off" =
      explicitEnv ? "explicit-env" : settingOn ? "default-settings" : "off";

    /**
     * The gate's one terminal report, to the audit log and to the renderer at
     * the same time.
     *
     * They are written together because they are the same claim: the audit
     * event is how the outcome is monitored, and the boot outcome is how the
     * person using the app is told what happened to a setting they turned on.
     * Two separate calls at six branches is two lists to keep in step, and a
     * branch that told the log one thing and the surface another would be worse
     * than a branch that told the surface nothing.
     */
    const recordGate = (
      outcome: SandboxGateAction,
      reason: SandboxGateReason,
      dependencyErrors: readonly string[] = [],
      causes: readonly SandboxStartFailureCause[] = [],
    ): void => {
      bootAuditLogger.logSandboxGate({
        platform: process.platform,
        onSignal: sandboxGateOnSignal,
        outcome,
        reason,
      });
      setSandboxBootOutcome({
        action: outcome,
        reason,
        onSignal: sandboxGateOnSignal,
        dependencyErrors,
        causes,
      });
    };

    // Tracks whether ASRT genuinely activated this boot. The interlock warning
    // below keys on THIS (not on `sandboxOptIn`), so the degraded path (gate ON,
    // sandbox inactive) still fires it. See shouldWarnHostClassifyInterlock.
    let sandboxActive = false;

    if (sandboxOptIn) {
      const deps = await checkAsrtDependencies();
      const dependencyCauses = deps.errors.length > 0
        ? classifySandboxDependencyErrors(process.platform, deps.errors, deps.dependencyFailure)
        : [];
      // Windows (proxy-egress PR 9): agent shells run in Microsoft Execution
      // Containers where the host offers them, srt-win or not; see
      // windows-sandbox-plan.ts for the four cases. The plan is recorded for
      // Settings on every branch below, so no case falls back unseen.
      const windowsInputs = process.platform === "win32"
        ? await detectWindowsBootInputs(shellRequested, workerRequested, deps.errors.length === 0)
        : undefined;
      const windowsPlan = windowsInputs === undefined ? undefined : planWindowsSandbox(windowsInputs);
      // What ASRT actually started as: the plan, or `proxy-only` after a
      // failed srt-win start (see canRetryWindowsAsProxyOnly).
      let windowsStart = windowsPlan?.start;
      /**
       * Record what carries Windows shells and extensions for ASRT started as
       * `started` (`failed`: init threw after all). While MXC is `checking`,
       * the PowerShell start probe runs off the boot path; its result replaces
       * the record only if nothing re-recorded it meanwhile.
       */
      const recordWindows = (started: "srt-win" | "proxy-only" | "none", failed: boolean): void => {
        if (windowsInputs === undefined) return;
        const at = (mxc: WindowsSandboxPlanInputs["mxc"]) => {
          const substrate = windowsSubstrateFor({ ...windowsInputs, mxc }, started);
          return failed ? windowsSubstrateWithoutAsrt(substrate) : substrate;
        };
        const first = at(windowsInputs.mxc);
        setWindowsSandboxSubstrate(first, first.shells === "mxc" ? mxcShellCapability() : undefined);
        if (started === "proxy-only" && !failed) {
          setActiveSandboxCapability(windowsProxyOnlyCapability(first));
        }
        if (windowsInputs.mxc.state !== "checking") return;
        const recorded = getWindowsSandboxSubstrate();
        void settleWindowsMxcStartProbe().then((mxc) => {
          if (getWindowsSandboxSubstrate() !== recorded) return;
          const settled = at(mxc);
          setWindowsSandboxSubstrate(settled, settled.shells === "mxc" ? mxcShellCapability() : undefined);
          if (started === "proxy-only" && !failed) {
            setActiveSandboxCapability(windowsProxyOnlyCapability(settled));
          }
          log.info(
            "boot: Windows sandbox settled — MXC %s, shells: %s, shell egress identity: %s",
            mxc.state === "unavailable" ? `unavailable (${mxc.reason})` : mxc.state,
            settled.shells,
            settled.shellEgressIdentity,
          );
        });
      };
      // Windows never aborts (see the abort branch), so a proxy-only boot
      // leaves extensions exactly as unconfined as the degrade it replaces,
      // and additionally confines the agent shells.
      const decision: { action: SandboxGateAction; reason: SandboxGateReason } =
        windowsPlan?.start === "proxy-only"
          ? { action: "activate", reason: "activate-windows-mxc-proxy-only" }
          : decideSandboxGate({
              settingOn,
              explicitEnv,
              platform: process.platform,
              depsOk: deps.errors.length === 0,
            });

      const privacyFailure = getAveHomePrivacyFailure();
      if (privacyFailure !== undefined && windowsStart !== "proxy-only") {
        const path = privacyFailure.failedPath ?? privacyFailure.home;
        log.warn("boot: extension isolation is OFF; AVE_HOME privacy failed (%s, %s). Extensions require session approval in Settings > Permissions.", privacyFailure.category, path);
        recordWindows("none", true);
        recordGate("degrade", "degrade-ave-home-privacy-failed", [privacyFailure.reason], ["ave-home-privacy-failed"]);
      } else if (decision.action === "abort") {
        // EXPLICIT opt-in (AVE_SANDBOX_ENABLED=1 or AVE_PLUGIN_WORKER_CONFINEMENT=1)
        // on mac/linux + the sandbox
        // cannot activate (bwrap/socat/ripgrep missing). The operator demanded
        // the sandbox by name; the no-fallback rule forbids silently dropping to
        // an unsandboxed plain spawn — that would honor the opt-in name while
        // delivering isolation=none. Throw so boot aborts loudly. Reachable ONLY
        // for the explicit env opt-in: the DEFAULT/settings-on path degrades
        // instead (decideSandboxGate), and Windows never aborts (a throw would
        // brick first-run before the install can happen).
        const message =
          `boot: OS tool sandbox is ON via ${explicitEnvLabel} but its dependencies are missing — refusing to start. ` +
          `Install the sandbox dependencies (Linux: bwrap, socat, ripgrep) or unset ${explicitEnvNames.join(" and ")}. ` +
          `Missing: ${deps.errors.join("; ")}`;
        log.error(message);
        recordGate("abort", decision.reason, deps.errors, dependencyCauses);
        await bootAuditLogger.flush();
        throw new Error(message);
      } else if (decision.action === "degrade") {
        // DEFAULT / settings-on (NOT the explicit env) + the sandbox cannot
        // activate (Linux deps missing, or Windows srt-win not installed).
        // GRACEFUL, non-bricking: keep the sandbox INACTIVE (isAsrtSandboxActive()
        // stays false → host shell tools run via the plain spawn path,
        // isolation=none) and never publish a capability, so the reviewer/UI SOT
        // honestly reports kind="none". This is the SAME runtime posture as
        // sandbox-OFF, a known-safe state. We do NOT abort on staged/default
        // settings paths: a host missing deps must degrade, not brick. LOUD on
        // purpose so the gap is never silent. (Set AVE_SANDBOX_ENABLED=1 to
        // make mac/linux fail-closed instead.)
        const detail = deps.errors.join("; ");
        if (process.platform === "win32") {
          log.warn(
            "boot: OS tool sandbox is ON but the Windows sandbox (srt-win) is NOT ready — " +
              "tools run with NO OS isolation until setup completes. " +
              (dependencyCauses.includes("windows-sandbox-missing") || dependencyCauses.includes("windows-sandbox-integrity-failed")
                ? "Repair or reinstall Ave, then restart the app. "
                : "Complete the one-time administrator install, then restart the app. ") +
              "Windows confines filesystem + network, but not process isolation. " +
              `Detail: ${detail}`,
          );
        } else {
          log.warn(
            "boot: OS tool sandbox is ON by default but its dependencies are missing — " +
              "tools run with NO OS isolation (unsandboxed, isolation=none) until the deps are installed. " +
              "Install the sandbox dependencies (Linux: bwrap, socat, ripgrep) to activate it, or turn it off " +
      "in Settings → Permissions 'OS tool sandbox'. (Set AVE_SANDBOX_ENABLED=1 for shells or " +
      "AVE_PLUGIN_WORKER_CONFINEMENT=1 for extension processes to make this fail-closed instead.) " +
              `Missing: ${detail}`,
          );
        }
        recordWindows("none", false);
        recordGate("degrade", decision.reason, deps.errors, dependencyCauses);
      } else {
        // decision.action === "activate" — deps present, initialize ASRT. Wrapped
        // so a runtime init FAILURE degrades-or-aborts by the SAME explicit-vs-
        // default rule (see the catch below), not an unconditional boot abort.
        try {
          if (deps.warnings.length > 0) {
            log.warn("boot: ASRT dependency warnings: %s", deps.warnings.join("; "));
          }
          // Network model (proxy-egress PR 4, design B): ASRT runs NON-strict
          // with an EMPTY allowedDomains, so every connection a sandboxed
          // process opens reaches the egress ask callback (egress-ask.ts),
          // which decides by who opened it. Each wrap gets its own proxy
          // listener (the carried ASRT patch), so on macOS and Linux "who" is
          // the kernel-enforced channel, not the forgeable proxy username:
          //   - a plugin worker reaches its OWN extension's declared domains and
          //     the configured model endpoints, nothing else, and is never asked;
          //   - a shell reaches what a grant covers, otherwise the person is
          //     asked on the approval dock (denied when nobody can answer);
          //   - a terminal tab reaches what a grant covers, otherwise the
          //     person is asked in that tab's banner (denied after 120 s);
          //   - anything unattributed is denied.
          // A pre-allowed domain in ASRT config would let every shell reach it
          // without asking, which is why the per-extension lists live in the
          // callback (invariant I4).
          //
          // This gate runs BEFORE startPlugins(), so the extension half of the
          // allowlists is empty here; startPluginsOnce refreshes it right after
          // load() and before startAll().
          const workerAllowlists = await buildWorkerEgressAllowlists();
          const { setWorkerEgressAllowlists, createEgressAskRuntimeCallback } = await import(
            "../../permissions/egress-runtime.js"
          );
          setWorkerEgressAllowlists(workerAllowlists);
          const egressAskCallback = createEgressAskRuntimeCallback({
            approvalGate: ctx.approvalGate,
            // Shipped on: settings-defaults sets it, and the service merges
            // stored flags over the defaults.
            shellAskEnabled: () => settingsService.get("features")?.shellEgressAsk === true,
          });
          // Trust boundary: WEAKENING flags are NOT set here (deny-by-default,
          // no Apple events / weaker isolation / unix-socket opening). Only the
          // enforced allow-list + strict flag. Per-command filesystem scoping
          // (write-jail + HOME read-deny) is applied at the call site via the
          // narrow `filesystem` option, never here as a weakening channel.
          // Before the first wrap, because ASRT reads the variable this sets
          // from THIS process's environment at wrap time — a value published
          // after a wrap would apply to some children and not others, which is
          // the one shape a temp-root decision must not have.
          // The principals' temp directories and the sandbox HOMEs are emptied
          // first, while no confined process exists to use one — the plugins
          // have not started. That is what removes the temp directory of a
          // plugin uninstalled, or an MCP server dropped, since the last start,
          // and every HOME a process that did not exit cleanly left behind.
          // Anything THIS process created is kept, whatever started first.
          await sweepSandboxPrivateRoots();
          // Both roots exist before the first wrap: Linux's bwrap skips a read
          // deny on a path that is not there, so a root created afterwards
          // would be visible to every process wrapped before it.
          ensureSandboxPrivateRoot(appOwnedSandboxHomeRoot());
          const sandboxTempRoot = useAppOwnedSandboxTempRoot();
          // Proxy-deny visibility (egress-deny-monitor.ts): subscribed before
          // the proxy starts, so no refusal precedes the subscription. ASRT's
          // violation store is module state and exists before initialize().
          {
            const [{ startEgressDenyMonitor }, { emitSandboxAudit }] = await Promise.all([
              import("../../permissions/egress-deny-monitor.js"),
              import("../../audit/sandbox-audit-sink.js"),
            ]);
            await startEgressDenyMonitor({
              subscribe: subscribeAsrtViolations,
              emit: emitSandboxAudit,
              capability: detectSandboxCapability,
            });
          }
          // Where allowed connections go next (owner decision 2026-10-20):
          // the main-owned `upstreamProxy` setting, read per destination so a
          // change applies without a restart (the cache is cleared on every
          // write). Default "Use system settings": the app's own proxy
          // environment, else the OS configuration through Chromium's
          // resolver (PAC/WPAD included). Entries the sandbox cannot use are
          // passed over with an audit row.
          const upstreamRouter = await (async () => {
            const [{ createUpstreamProxyRouter, upstreamProxyDeps }, { maskSensitiveData }, { emitSandboxAudit }] = await Promise.all([
              import("../../permissions/upstream-proxy.js"),
              import("../../audit/dlp-filter.js"),
              import("../../audit/sandbox-audit-sink.js"),
            ]);
            const mask = (text: string): string => maskSensitiveData(text).masked;
            const upstream = createUpstreamProxyRouter(upstreamProxyDeps(settingsService, ctx.host.resolveProxy, (event) => {
              emitSandboxAudit({
                timestamp: new Date().toISOString(),
                entryKind: "egress-route",
                destination: { host: mask(event.host), port: event.port },
                source: event.source,
                skipped: event.skipped.map(mask),
              }).catch((error: unknown) => log.warn(`[sandbox] upstream route audit write failed: ${errorMessage(error)}`));
            }));
            // A change applies to new connections at once (the cache is
            // dropped, its generation advanced) and closes the open ones.
            // Pending decisions observe that generation again before dialing.
            settingsService.onChanged("upstreamProxy", () => {
              upstream.invalidate();
              const closed = closeAllEgressConnections();
              if (closed > 0) log.info(`[sandbox] upstream proxy setting changed; closed ${closed} open sandbox connection(s)`);
            });
            return upstream.router;
          })();
          const initializeAs = (start: typeof windowsStart) =>
            initializeAsrtSandbox({
              allowedDomains: [],
              strictAllowlist: false,
              upstreamRouter,
              // Thread the REAL Electron userData path so the deny-list is exact
              // (handles --user-data-dir, XDG_CONFIG_HOME, future renames).
              // Safe: boot.ts is main-process only and already imports electron.
              userDataDir: ctx.host.userDataPath,
              // Windows with MXC and no srt-win: run the proxy only.
              ...(start === "proxy-only" ? { windows: { externalConfinement: true } } : {}),
            }, egressAskCallback);
          try {
            await initializeAs(windowsStart);
          } catch (srtWinErr) {
            // srt-win passed its dependency check but its session setup threw
            // (ASRT clears its config before starting the proxy, so a second
            // initialize is clean). MXC shells need only the proxy.
            if (windowsInputs === undefined || windowsStart === undefined || !canRetryWindowsAsProxyOnly(windowsInputs, windowsStart)) {
              throw srtWinErr;
            }
            log.warn(
              "boot: the Windows sandbox (srt-win) failed to start — extensions run with NO OS isolation this session; " +
                "retrying ASRT as the proxy only so agent shells can run in Microsoft Execution Containers. " +
                `Cause: ${errorMessage(srtWinErr)}`,
            );
            windowsStart = "proxy-only";
            await initializeAs(windowsStart);
          }
          // Publish the active capability to the SOT now that ASRT is
          // genuinely initialized (gate ON, deps present). detectSandboxCapability
          // + the reviewer/UI consumers read this; the reviewer's per-category
          // relaxation (sandboxRelaxesCategory) reads the `confines` we publish
          // here. When the gate is OFF — or on the Windows-not-ready / mac-linux
          // deps-missing paths above where ASRT is NOT initialized — we never
          // call this, so the SOT stays kind="none" (isolation=none), matching
          // reality.
          //
          // Per-platform confinement (HONEST, not hardcoded full):
          //   - macOS (Seatbelt) / Linux (bwrap): full — fs + process + network.
          //   - Windows (srt-win): partial — filesystem + network, no process.
          const asrtBackend =
            process.platform === "darwin"
              ? "Seatbelt"
              : process.platform === "win32"
                ? windowsStart === "proxy-only" ? "proxy only, shells in MXC" : "srt-win"
                : "bwrap";
          const confinementKind = process.platform === "win32" ? "partial" : "full";
          const confines = sandboxConfinementForPlatform(
            process.platform,
            confinementKind,
          );
          const reason =
            process.platform === "win32"
              ? `ASRT (${asrtBackend}) active — filesystem + network contained, process isolation unavailable`
              : `ASRT (${asrtBackend}) active — fs+process+network contained`;
          if (windowsStart !== "proxy-only") {
            setActiveSandboxCapability({
              kind: "asrt",
              confidence: "verified",
              platform: process.platform,
              reason,
              // Machine-checkable confinement for the host-shell substrate. Full
              // on mac/linux; partial on Windows — see sandboxConfinementForPlatform.
              confines,
            });
          }
          if (windowsInputs !== undefined && windowsStart !== undefined) {
            recordWindows(windowsStart, false);
            const substrate = windowsSubstrateFor(windowsInputs, windowsStart);
            // A retried srt-win start already warned, with its cause.
            if (workerRequested && substrate.extensions === "none" && windowsPlan?.start !== "srt-win") {
              log.warn(
                "boot: extension confinement is ON but the Windows sandbox (srt-win) is NOT ready — " +
                  "plugin workers, plugin children, plugin hooks and MCP stdio servers run with NO OS isolation " +
                  "until the one-time administrator install completes; agent shells run in Microsoft Execution Containers " +
                "once the container start check passes.",
              );
            }
            log.info(
              "boot: Windows sandbox — MXC %s, shells: %s, extensions: %s, shell egress identity: %s",
              substrate.mxc.state,
              substrate.shells,
              substrate.extensions,
              substrate.shellEgressIdentity,
            );
          }
          log.info(
            "boot: ASRT OS tool sandbox initialized (%s, %s, egress decided per connection by the ask callback; %d model endpoints at init, extension allowlists refreshed after plugin load; confined temp root %s)",
            process.platform,
            asrtBackend,
            workerAllowlists.modelEndpointHosts.length,
            sandboxTempRoot,
          );
          sandboxActive = true;
          recordGate(
            "activate",
            windowsStart === "proxy-only" ? "activate-windows-mxc-proxy-only" : decision.reason,
            deps.errors,
            dependencyCauses,
          );
        } catch (initErr) {
          // Init FAILURE (initializeAsrtSandbox threw despite deps present) is the
          // SAME "cannot activate" condition as deps-missing — re-decide with
          // depsOk:false so the explicit-vs-default branch lives in one place.
          // initializeAsrtSandbox flips its active flag ONLY on success, so a
          // throw leaves isAsrtSandboxActive() false and no capability published.
          const failDecision = decideSandboxGate({
            settingOn,
            explicitEnv,
            platform: process.platform,
            depsOk: false,
          });
          const runtimeProbeFailed =
            process.platform === "linux" && isAsrtLinuxRuntimeProbeError(initErr);
          const failureReason: SandboxGateReason = runtimeProbeFailed
            ? failDecision.action === "abort"
              ? "abort-linux-runtime-probe-failed"
              : "degrade-linux-runtime-probe-failed"
            : process.platform === "win32"
              // Not "not installed": the dependency check passed and the start threw.
              ? "degrade-windows-init-failed"
              : failDecision.reason;
          const cause = errorMessage(initErr);
          const failureCauses: SandboxStartFailureCause[] = [
            runtimeProbeFailed ? "linux-runtime-probe-failed" : "init-failed",
          ];
          if (failDecision.action === "abort") {
            // EXPLICIT opt-in — fail-closed even on init failure.
            log.error(
              `boot: OS tool sandbox is ON via ${explicitEnvLabel} but ASRT initialization failed — refusing to start. ` +
                `Cause: ${cause}`,
            );
            recordGate("abort", failureReason, [cause], failureCauses);
            await bootAuditLogger.flush();
            throw initErr;
          }
          // DEFAULT / settings-on (or Windows) — GRACEFUL degrade, non-bricking.
          log.warn(
            "boot: OS tool sandbox is ON by default but ASRT initialization failed — " +
              "tools run with NO OS isolation (unsandboxed, isolation=none) this session. " +
              "(Set AVE_SANDBOX_ENABLED=1 for shells or AVE_PLUGIN_WORKER_CONFINEMENT=1 for extension processes " +
                "to make this fail-closed instead.) " +
              `Cause: ${cause}`,
          );
          recordWindows(windowsStart ?? "none", true);
          recordGate("degrade", failureReason, [cause], failureCauses);
          // sandboxActive stays false: a Linux runtime-probe failure never
          // publishes a verified capability, so UI/reviewer remain kind="none".
        }
      }
    } else {
      // Gate OFF (neither on-signal set) → skip. On the staged rollout this is
      // the Linux/Windows default-off path. Log the enable hint on darwin (where
      // off is now a deliberate opt-out); emit the skip telemetry on EVERY
      // platform so the off-rate is monitorable alongside activate/degrade/abort.
      if (process.platform === "darwin") {
        log.info(
    "boot: OS tool sandbox gated off (enable via Settings → Permissions, or AVE_SANDBOX_ENABLED=1 for shells / " +
      "AVE_PLUGIN_WORKER_CONFINEMENT=1 for extension processes)",
        );
      }
      recordGate("skip", "gate-off");
    }

    // Flag-interlock warning (no hard interlock — the flags stay independent).
    // Keyed on the ACTUAL sandbox-active state so it fires on EVERY
    // sandbox-inactive path: gate off, OR the new DEGRADED path (gate ON by
    // default but the sandbox could not activate). The explicit-abort path never
    // reaches here (boot already threw). `hostClassifiesRisk` gates plugin tools
    // at the effect boundary, which does NOT contain off-hostApi mutations
    // (direct node:fs / bare fetch / detached async frames) — only the OS sandbox
    // does. Warn LOUDLY once so the operator sees the uncontained residual; we
    // deliberately do NOT block (the flags remain independently togglable).
    if (
      shouldWarnHostClassifyInterlock({
        hostClassifiesRisk: settingsService.get("features")?.hostClassifiesRisk ?? false,
        // The residual is plugin code, so only plugin-worker confinement
        // contains it: ASRT active for shells alone leaves it uncontained.
        sandboxActive: sandboxActive && workerRequested,
      })
    ) {
      log.warn(
        "boot: hostClassifiesRisk is ON but plugin-worker confinement (pluginWorkerConfinement / AVE_PLUGIN_WORKER_CONFINEMENT) is NOT active — " +
          "effect-boundary classification does NOT contain off-hostApi mutations (direct node:fs, bare fetch, " +
          "detached async frames) without the OS sandbox. For that residual, host-classify WITHOUT the sandbox is " +
          "weaker than the pre-exec ask it replaces. Install/enable the OS sandbox to contain it, or keep the " +
          "pre-exec ask (turn hostClassifiesRisk off) until the sandbox is active.",
      );
    }
  }
}

/**
 * Empty both sandbox private roots, each keeping the directories this process
 * created in it: the principals' temp directories, and the sandbox HOMEs. A
 * root that cannot be emptied is reported and left; the read floor still
 * denies it.
 */
export async function sweepSandboxPrivateRoots(): Promise<void> {
  const { appOwnedSandboxHomeRoot, appOwnedSandboxTempRoot, sandboxTempPrincipalDirsInUse } =
    await import("../../permissions/asrt-sandbox.js");
  const { sandboxProcessHomesInUse } = await import("../../permissions/sandbox-process-home.js");
  const roots = [
    [appOwnedSandboxTempRoot(), sandboxTempPrincipalDirsInUse()],
    [appOwnedSandboxHomeRoot(), sandboxProcessHomesInUse()],
  ] as const;
  // Ahead of the loop, and not caught by it: a test naming the real home must
  // fail, with neither root touched.
  for (const [root] of roots) checkSandboxSweepRoot(root);
  for (const [root, inUse] of roots) {
    await sweepSandboxPrivateRoot(root, inUse).catch((error: unknown) => {
      log.warn("boot: could not empty the sandbox root %s: %s", root, errorMessage(error));
    });
  }
}

/**
 * Remove everything under one of the sandbox private roots — the principals'
 * temp directories, or the sandbox HOMEs — except what this process created
 * (`inUse`), and whatever a version that still granted the temp root left in
 * it.
 *
 * Run at boot, before any confined process exists, so nothing is using a
 * directory it removes and nothing can change the tree while it is walked; the
 * `inUse` set keeps that true even for a spawn that ran first. No link is
 * followed: a root that is a link is unlinked, never listed; each entry is
 * removed with {@link removeOwnedPluginTree}, which deletes a link rather than
 * its target and takes back the modes and, on macOS, the user-immutable flags a
 * confined process could have set inside its own directory.
 */
export async function sweepSandboxPrivateRoot(root: string, inUse: ReadonlySet<string>): Promise<void> {
  checkSandboxSweepRoot(root);
  let entry;
  try {
    entry = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!entry.isDirectory()) {
    await unlink(root);
    return;
  }
  const canonicalRoot = await realpath(root);
  // What is there belongs to a running app: the HOMEs and temp directories of
  // its confined processes, which a sweep deletes.
  checkSandboxSweepRoot(canonicalRoot);
  for (const name of await readdir(root)) {
    if (inUse.has(join(root, name)) || inUse.has(join(canonicalRoot, name))) continue;
    await removeOwnedPluginTree(join(root, name));
  }
}

/**
 * The boot-path half of MXC detection (launcher pin, probe, dry run) and the
 * plan inputs. A pass is `checking`: the PowerShell start probe runs after
 * boot ({@link settleWindowsMxcStartProbe}). An MXC that cannot carry the
 * shells is logged with its reason; the code reaches Settings too.
 */
async function detectWindowsBootInputs(
  shellRequested: boolean,
  workerRequested: boolean,
  srtWinReady: boolean,
): Promise<WindowsSandboxPlanInputs> {
  const { detectHostMxcPrerequisites } = await import("../../permissions/mxc-windows.js");
  const mxc = await detectHostMxcPrerequisites();
  if (mxc.state === "unavailable") logMxcUnavailable(mxc.reason, mxc.windowsBuild, mxc.detail);
  return {
    shellRequested,
    workerRequested,
    mxc: mxc.state === "available" ? { state: "checking" } : { state: "unavailable", reason: mxc.reason },
    windowsBuild: mxc.windowsBuild,
    srtWinReady,
  };
}

/** The slow half: a real PowerShell 5.1 start in a container, after boot. */
async function settleWindowsMxcStartProbe(): Promise<WindowsSandboxPlanInputs["mxc"]> {
  const { probeHostMxcPowerShellStart } = await import("../../permissions/mxc-windows.js");
  const started = Date.now();
  try {
    const mxc = await probeHostMxcPowerShellStart();
    log.info("boot: MXC PowerShell start probe finished in %d ms (%s)", Date.now() - started, mxc.state);
    if (mxc.state === "available") return { state: "available" };
    logMxcUnavailable(mxc.reason, mxc.windowsBuild, mxc.detail);
    return { state: "unavailable", reason: mxc.reason };
  } catch (error) {
    logMxcUnavailable("powershell-start-failed", null, errorMessage(error));
    return { state: "unavailable", reason: "powershell-start-failed" };
  }
}

function logMxcUnavailable(reason: string, windowsBuild: string | null, detail: string): void {
  log.warn(
    "boot: Microsoft Execution Containers cannot confine agent shells on this host (%s, build %s): %s",
    reason,
    windowsBuild ?? "unknown",
    detail,
  );
}
