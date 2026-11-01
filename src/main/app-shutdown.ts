import type { BootHost } from "../boot/host-runtime.js";
import { browserTabRegistry } from "./browser/browser-tab-registry.js";
// Ordered teardown runs under a hard deadline so a wedged subsystem cannot hang app.quit(). Unordered cleanup belongs in registerShutdownHook instead of
// separate before-quit listeners.
import { createLogger, closeFileLogSink } from "../lib/logger.js";
import { logger as rootPinoLogger } from "../lib/logger.js";
import { runShutdownRoutines } from "./shutdown-routines.js";
import { stopLocalApiServer } from "./local-api-server.js";
import { stopTailnetObserverServer } from "./tailnet-surface-server.js";
import { stopTelegramBridgeServer } from "./telegram-bridge-server.js";
import { stopRemoteA2AReceiverServer } from "./a2a-remote-receiver-server.js";
import { stopSubscriptionRuntimes } from "./subscription-runtime-service.js";
import { stopHostDocumentEngineSessions } from "../observation/document-engine-host.js";
import {
  forceKillAndDrainManagedChildProcesses,
  forceKillManagedChildProcesses,
  sealManagedChildProcessAdmission,
} from "./managed-child-processes.js";
import { forceKillAllTerminalsForShutdown } from "./terminal/pty-manager.js";
import {
  resolveShutdownCleanupTimeoutMs,
  runCleanupWithHardTimeout,
} from "./shutdown-timeout.js";
import {
  getServices,
  isAppShutdownCompleted,
  setAppShutdownCompleted,
  setAppShutdownStarted,
} from "./app-state.js";
import { errorMessage } from "../shared/error-message.js";
import { interruptRunningTurnsForExit } from "../engine/turn/turn-journal.js";
import { disposeBrowserUploads } from "./browser/browser-upload.js";
import { drainMxcHolderLifetimes, sealMxcHolderLifetimeAdmission } from "../permissions/mxc-holder-lifetime.js";

// How long a quit waits for running turns to record themselves as interrupted. Their rows are already on disk as they happen (the turn journal), so this
// buys the clean interrupted record, not the data, and stays short.
const RUNNING_TURN_EXIT_WAIT_MS = 3_000;

const log = createLogger("ave");
let shutdownHost: BootHost | undefined;
// The plugin side of stopping an interrupted bootstrap, in the order the normal shutdown uses: plugin shutdown handlers first, the runtime last.
export interface BootPluginShutdown {
  runShutdownHandlers(): Promise<void>;
  // Close plugin admission without stopping anything (before MCP disconnects).
  closeAdmission(): void;
  stopRuntime(signal: AbortSignal): Promise<unknown>;
}
let bootPluginShutdown: BootPluginShutdown | undefined;
let bootMcpDisconnect: (() => Promise<void>) | undefined;
export function registerBootPluginShutdown(shutdown: BootPluginShutdown): void {
  bootPluginShutdown = shutdown;
}
// Registered once the bootstrap has an MCP manager to disconnect.
export function registerBootMcpDisconnect(disconnect: () => Promise<void>): void {
  bootMcpDisconnect = disconnect;
}
export function configureAppShutdownHost(host: BootHost): void {
  shutdownHost = host;
}

// Hooks are synchronous, independent, and share one before-quit listener; ordered dependencies belong in runAppShutdownCleanup.
interface ShutdownHook {
  readonly name: string;
  readonly stop: () => void;
}

const shutdownHooks: ShutdownHook[] = [];
let shutdownHooksRan = false;

function runShutdownHook(hook: ShutdownHook): void {
  try {
    hook.stop();
  } catch (err) {
    log.warn("shutdown hook failed (%s): %s", hook.name, errorMessage(err));
  }
}

// Run late-registered hooks immediately after the drain; a quit deferred during boot may never drain again.
export function registerShutdownHook(name: string, stop: () => void): void {
  const hook: ShutdownHook = { name, stop };
  if (shutdownHooksRan) {
    runShutdownHook(hook);
    return;
  }
  shutdownHooks.push(hook);
}

// Drain once before ordered-cleanup guards; contain throwing hooks so remaining cleanup still runs.
export function runShutdownHooks(): void {
  if (shutdownHooksRan) return;
  shutdownHooksRan = true;
  for (const hook of shutdownHooks) runShutdownHook(hook);
}

// Flush the final timeout diagnostic before hard exit, with its own short deadline so logging cannot defeat shutdown.
async function flushLogger(): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Hard cap so a stuck transport can't defeat the timeout itself.
    const cap = setTimeout(finish, 500);
    cap.unref?.();
    try {
      rootPinoLogger.flush(() => {
        clearTimeout(cap);
        finish();
      });
    } catch {
      clearTimeout(cap);
      finish();
    }
  });
}

export type AppShutdownCleanupOutcome = "completed" | "skipped" | "timed-out" | "failed";
let appShutdownCleanupPromise: Promise<AppShutdownCleanupOutcome> | null = null;

// Stop a rejected or interrupted bootstrap before AppServices is published.
export async function runIncompleteBootShutdown(host?: BootHost): Promise<AppShutdownCleanupOutcome> {
  const reason = "host bootstrap interrupted or failed";
  setAppShutdownStarted(true);
  sealMxcHolderLifetimeAdmission(reason);
  sealManagedChildProcessAdmission(reason);
  runShutdownHooks();
  const result = await runCleanupWithHardTimeout(async (signal) => {
    const failures: unknown[] = [];
    const stages = [
      () => bootPluginShutdown?.runShutdownHandlers(),
      // Close plugin admission before MCP disconnects, then stop the runtime only after in-flight MCP calls finish.
      () => bootPluginShutdown?.closeAdmission(),
      () => bootMcpDisconnect?.(),
      () => bootPluginShutdown?.stopRuntime(signal),
      () => stopHostDocumentEngineSessions(),
      () => stopSubscriptionRuntimes(),
      () => disposeBrowserUploads(),
      () => forceKillAllTerminalsForShutdown(),
      () => drainMxcHolderLifetimes(),
      () => forceKillAndDrainManagedChildProcesses(reason),
      () => host?.close(),
    ];
    for (const stage of stages) {
      if (signal.aborted) return;
      try { await stage(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "incomplete host bootstrap cleanup failed");
  }, resolveShutdownCleanupTimeoutMs(undefined));
  if (result.status !== "completed") {
    forceKillManagedChildProcesses(reason);
    // PTYs use a separate native owner. Signal them even if an earlier stage exhausted the deadline; a zero wait budget does not extend that deadline.
    await forceKillAllTerminalsForShutdown(0);
    log.error({ status: result.status }, "incomplete host bootstrap cleanup did not complete");
  }
  await flushLogger();
  closeFileLogSink();
  return result.status;
}

export async function runAppShutdownCleanup(options: {
  reason: "before-quit" | "app-update-install";
  exitOnTimeout: boolean;
}): Promise<AppShutdownCleanupOutcome> {
  const services = getServices();
  if (!services || isAppShutdownCompleted()) return "skipped";
  if (appShutdownCleanupPromise) return appShutdownCleanupPromise;

  setAppShutdownStarted(true);
  sealMxcHolderLifetimeAdmission(options.reason);
  sealManagedChildProcessAdmission(options.reason);
  const svc = services;
  const cleanupTimeoutMs = resolveShutdownCleanupTimeoutMs(
    svc.settingsService.get("system")?.shutdownCleanupTimeoutMs,
  );
  appShutdownCleanupPromise = (async () => {
    const result = await runCleanupWithHardTimeout(async (signal) => {
      // Keep runtime children through normal plugin teardown, but stop them on earlier failure or timeout without masking the original error.
      let subscriptionRuntimesStopped = false;
      let holderDrainAttempted = false;
      let shutdownFailure: unknown;
      try {
      // Release global shortcuts before async shutdown steps can hang or throw.
      shutdownHost?.desktop?.beforeShutdown();
      // Dispose the always-on-top dock before later stages can wedge; peek without creating a dock solely for teardown.

      if (signal.aborted) return;
      // Running turns first, before any stage that can stall: each is aborted as `host-exit` and given a bounded moment to write its interrupted row, so the
      // session reopens with the partial answer and Continue.
      const interrupted = await interruptRunningTurnsForExit(RUNNING_TURN_EXIT_WAIT_MS);
      if (interrupted.turns > 0) {
        log.info(
          { turns: interrupted.turns, settled: interrupted.settled },
          "shutdown: interrupted running turns",
        );
      }
      if (signal.aborted) return;
      // Await converter exit and private-directory cleanup before service teardown and the generic child drain.
      await stopHostDocumentEngineSessions();
      if (signal.aborted) return;
      await disposeBrowserUploads();
      await browserTabRegistry.flushBindingWrites().catch((error: unknown) => {
        log.error({ error }, "shutdown: tab bindings could not be persisted");
      });
      if (signal.aborted) return;
      // Close local API streams and blank discovery early so stale bearer credentials and ports cannot survive shutdown.
      await stopLocalApiServer();
      if (signal.aborted) return;
      // Tailnet observer is a separate listener over the shared projection. Close its SSE streams before the host conversation runtime is disposed.
      await stopTailnetObserverServer();
      if (signal.aborted) return;

      // Telegram is a distinct external-platform ingress/egress adapter. Its runtime guard is revoked before the shared conversation services go down, so a
      // late webhook or queued delivery cannot outlive shutdown.
      await stopTelegramBridgeServer();
      if (signal.aborted) return;

      // Independent P4-5 listener: close it before the owning remote runtime is disposed by services.shutdown(). This is a no-op when its gate was OFF and is
      // idempotent on repeated cleanup attempts.
      await stopRemoteA2AReceiverServer();
      if (signal.aborted) return;
      await svc.runPluginShutdownHandlers?.();
      if (signal.aborted) return;
      // v2 shutdown routines — fire all active shutdown-trigger routines with a 5s timeout so a hung LLM call cannot block app.quit() indefinitely.
      await runShutdownRoutines(svc);
      if (signal.aborted) return;
      // Plugin shutdown handlers and shutdown-trigger routines may make normal host LLM calls. Keep the subscription runtime live for both, then stop it
      // immediately at the service-shutdown boundary so no later teardown can create a new text session.
      await stopSubscriptionRuntimes();
      subscriptionRuntimesStopped = true;
      if (signal.aborted) return;
      // Plugin admission closes before services shut down — MCP disconnects there — so no post-commit MCP publication or new plugin dispatch can open after
      // it. Calls already admitted keep running; the runtime itself stops further below.
      svc.pluginRuntime.beginShutdown();
      await svc.shutdown?.();
      if (signal.aborted) return;
      // After service shutdown, admit no broker shells and await terminal ownership evidence for every remote handle.
      // Local child drain cannot prove remote termination; transport failure is explicit and external workload release remains the backstop.
      const { backgroundShellManager } = await import("../tools/shell-tools.js");
      backgroundShellManager.disposeAllBrokerShells(signal);
      const brokerCleanupReports = await backgroundShellManager.waitForAllBrokerCleanup();
      const unprovenBrokerCleanup = brokerCleanupReports.filter((report) =>
        report.state !== "complete" ||
        report.outcomes.some((outcome) => outcome.requiresExternalRelease),
      );
      if (unprovenBrokerCleanup.length > 0) {
        throw new Error(
          `workload-broker:shutdown-cleanup-unproven:${unprovenBrokerCleanup.length}`,
        );
      }
      if (signal.aborted) return;
      // Kill any live interactive PTY terminals (#1444). The pty children are NOT in the managed-child tracker (node-pty's IPty is not a ChildProcess), so
      // force them down here on the graceful path.
      await forceKillAllTerminalsForShutdown();
      // Bounded by the same deadline as every other stage: plugin generations still retiring when it passes are named, and the backstop below ends them.
      await svc.pluginRuntime.stopAll({ signal });
      if (signal.aborted) return;
      holderDrainAttempted = true;
      await drainMxcHolderLifetimes();
      // Runtime stop hooks can return after scheduling TERM→KILL. Keep the app alive for a bounded definitive-exit drain so ASRT/HOME finalizers run before
      // Electron completes an otherwise clean shutdown.
      await forceKillAndDrainManagedChildProcesses(`${options.reason} graceful shutdown`);
      } catch (error) {
        shutdownFailure = error;
        throw error;
      } finally {
        if (!subscriptionRuntimesStopped) {
          try {
            await stopSubscriptionRuntimes();
          } catch {
            // Preserve the original shutdown-stage failure. The failed branch below performs a managed-child force-kill as the final fallback.
            log.warn("shutdown: subscription runtime fallback stop failed");
          }
        }
        // An earlier stage may have failed before plugin teardown. Retain each
        // native owner through its own cleanup before the generic kill backstop.
        if (!holderDrainAttempted) {
          try { await drainMxcHolderLifetimes(); } catch (error) {
            if (shutdownFailure !== undefined) throw new AggregateError([shutdownFailure, error], "Application and container holder cleanup failed");
            throw error;
          }
        }
      }
    }, cleanupTimeoutMs);

    if (result.status === "timed-out") {
      // Force-kill BEFORE the log line so killedChildCount reflects what actually happened, not an optimistic pre-kill count.
      const killedChildCount = forceKillManagedChildProcesses(`${options.reason} cleanup timeout`);
      await shutdownHost?.close();
      log.error({
        timeoutMs: cleanupTimeoutMs,
        killedChildCount,
        reason: options.reason,
      }, "shutdown cleanup timed out");
      // Flush the logger so the diagnostic above (and any preceding warn about which subsystem hung) makes it to disk before the process leaves.
      await flushLogger();
      // Close the file log sink last so no shutdown or timeout diagnostic is lost.
      closeFileLogSink();
      setAppShutdownCompleted(true);
      if (options.exitOnTimeout) {
        // A hard exit here never reaches `will-quit`, so the code a headless run already chose is applied directly; a desktop run chose none.
        if (!shutdownHost) throw new Error("shutdown-host-unavailable");
        shutdownHost.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
      }
      return "timed-out";
    }

    if (result.status === "failed") {
      // A failed lifecycle stage may have prevented a runtime-owned child from acknowledging its graceful stop. The normal stop ran in the cleanup finally
      // block; this is only the last-resort descendant-safe backstop.
      const killedChildCount = forceKillManagedChildProcesses(`${options.reason} cleanup failed`);
      await shutdownHost?.close();
      log.error(
        { killedChildCount },
        "%s: shutdown cleanup failed: %s",
        options.reason,
        errorMessage(result.error),
      );
      await flushLogger();
      // LAST step (failed path): close the file sink after the failure diagnostic has been flushed. See the timed-out branch above.
      closeFileLogSink();
      setAppShutdownCompleted(true);
      return "failed";
    }

    await shutdownHost?.close();
    // LAST step (happy path): flush any remaining buffered logs, then close the production log file sink after every shutdown step has logged.
    await flushLogger();
    closeFileLogSink();
    setAppShutdownCompleted(true);
    return "completed";
  })();

  return appShutdownCleanupPromise;
}
