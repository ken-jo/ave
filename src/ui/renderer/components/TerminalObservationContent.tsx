import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/utils.js";
import { useTranslation } from "../../../i18n/react.js";
import type { EgressDecisionBasis } from "../../../audit/sandbox-audit.js";
import { isEgressGrantScope, type EgressGrantScope } from "../../../shared/egress-grant-scopes.js";
import {
  OBSERVATION_LIMITS,
  TERMINAL_OBSERVATION_LIMITS,
  type AgentObservationEvent,
  type ObservationBinding,
  type TerminalObservedCommand,
  type TerminalObservationEvent,
  type TerminalObservationDecision,
} from "../../../shared/agent-observation.js";

const EGRESS_BASIS_KEYS: Readonly<Record<EgressDecisionBasis, string>> = {
  "extension-allowlist": "terminalObservation.basis.extensionAllowlist",
  grant: "terminalObservation.basis.grant",
  rule: "terminalObservation.basis.rule",
  prompt: "terminalObservation.basis.prompt",
  policy: "terminalObservation.basis.policy",
  sandbox: "terminalObservation.basis.sandbox",
};
const EGRESS_SCOPE_KEYS: Readonly<Record<EgressGrantScope, string>> = {
  once: "terminalObservation.scope.once",
  session: "terminalObservation.scope.session",
  tab: "terminalObservation.scope.tab",
  project: "terminalObservation.scope.project",
  always: "terminalObservation.scope.always",
};

function decisionMessageKeys(decision: TerminalObservationDecision): { basis: string; scope: string } {
  if (!Object.hasOwn(EGRESS_BASIS_KEYS, decision.basis)
    || decision.scope !== null && !isEgressGrantScope(decision.scope)) {
    throw new Error("Invalid terminal egress decision.");
  }
  return { basis: EGRESS_BASIS_KEYS[decision.basis],
    scope: decision.scope === null ? "terminalObservation.scope.none" : EGRESS_SCOPE_KEYS[decision.scope] };
};

type ObservationError = "unavailable" | "resync-required";
interface TerminalObservationView {
  sessionId: string;
  binding: ObservationBinding;
  seq: number;
  commands: TerminalObservedCommand[];
  error?: ObservationError;
}

function elapsedSeconds(command: TerminalObservedCommand, now: number): number {
  return Math.max(0, Math.floor((command.status === "running" ? now - command.startedAt : command.durationMs) / 1_000));
}

/** One authenticated subscription per visible conversation transcript. */
export function useTerminalObservation(sessionId: string | undefined, observe: boolean) {
  const [view, setView] = useState<TerminalObservationView | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<{ sessionId: string; code: ObservationError } | null>(null);
  const [now, setNow] = useState(Date.now);
  const acknowledged = useRef("");

  useEffect(() => {
    setView(null);
    setSubscriptionError(null);
    acknowledged.current = "";
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !observe) return;
    const preview = window.ave.preview;
    let disposed = false;
    let binding: ObservationBinding | undefined;
    let lastSeq = 0;
    let pending: TerminalObservationEvent[] = [];
    const fail = (code: ObservationError = "unavailable"): void => {
      if (disposed) return;
      setSubscriptionError({ sessionId, code });
      setView((previous) => previous?.sessionId === sessionId ? { ...previous, commands: [], error: code } : previous);
    };
    const release = (owner: ObservationBinding): void => {
      void preview.acknowledgeObservation({ action: "release", ...owner }).then((result) => {
        if (!result.ok && result.error !== "unauthorized") {
          if (disposed) console.error("Terminal observation release failed.");
          else fail();
        }
      }, () => {
        if (disposed) console.error("Terminal observation release failed.");
        else fail();
      });
    };
    const accept = (events: readonly TerminalObservationEvent[]): void => {
      if (!binding || disposed) return;
      for (const event of events) {
        if (event.target.id !== binding.targetId || event.sessionId !== sessionId || event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        if (event.kind === "snapshot") {
          setSubscriptionError(null);
          const commands = event.after.commands.slice(-TERMINAL_OBSERVATION_LIMITS.maxCommands);
          setView({ sessionId, binding, seq: event.seq, commands });
        } else {
          const error = event.after.code === "resync-required" ? "resync-required" : "unavailable";
          setView({ sessionId, binding, seq: event.seq, commands: [], error });
        }
      }
    };
    const stop = preview.onAgentObservation((events: AgentObservationEvent[]) => {
      if (disposed) return;
      const terminal = events.filter((event): event is TerminalObservationEvent =>
        event.source === "terminal" && event.actor === "agent" && event.sessionId === sessionId);
      if (binding) { accept(terminal); return; }
      for (const event of terminal) {
        const earlier = pending.find((value) => value.target.id === event.target.id);
        if (earlier && earlier.seq >= event.seq) continue;
        pending = pending.filter((value) => value.target.id !== event.target.id);
        pending.push(event);
        if (pending.length > OBSERVATION_LIMITS.maxViews
          || new TextEncoder().encode(JSON.stringify(pending)).byteLength > OBSERVATION_LIMITS.maxQueuedElementBytes) {
          pending = [];
          fail("resync-required");
          return;
        }
      }
    });
    void preview.acknowledgeObservation({ action: "subscribe-terminal", sessionId }).then((result) => {
      if (!result.ok || !result.observation || result.observation.sessionId !== sessionId) { fail(); return; }
      if (disposed) { release(result.observation); return; }
      const owner = result.observation;
      binding = owner;
      lastSeq = owner.seq;
      accept(pending);
      pending = [];
    }, () => fail());
    return () => {
      disposed = true;
      stop();
      pending = [];
      if (binding) release(binding);
    };
  }, [sessionId, observe]);

  const current = view?.sessionId === sessionId ? view : null;
  const error = current?.error ?? (subscriptionError && subscriptionError.sessionId === sessionId ? subscriptionError.code : undefined);
  const commands = useMemo(() => current?.commands ?? [], [current?.commands]);
  const running = commands.findLast((command) => command.status === "running");

  useEffect(() => {
    if (!running || !observe) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running?.id, observe]);

  useEffect(() => {
    if (!current) return;
    const key = `${current.binding.targetId}:${current.seq}`;
    if (acknowledged.current === key) return;
    acknowledged.current = key;
    const fail = (): void => {
      setView((previous) => previous?.binding.targetId === current.binding.targetId && previous.sessionId === current.sessionId
        ? { ...previous, commands: [], error: "unavailable" } : previous);
    };
    void window.ave.preview.acknowledgeObservation({ action: "rendered", targetId: current.binding.targetId,
      sessionId: current.sessionId, seq: current.seq }).then((result) => { if (!result.ok) fail(); }, fail);
  }, [current?.binding.targetId, current?.sessionId, current?.seq]);

  return useMemo(() => ({ sessionId, commands, error, now }), [sessionId, commands, error, now]);
}

export type TerminalObservationState = ReturnType<typeof useTerminalObservation>;

/** Read-only command presentation; callers select commands by their authenticated tool identity. */
export function TerminalObservationCommands({ observation, commands = observation.commands }: {
  observation: TerminalObservationState; commands?: TerminalObservedCommand[];
}) {
  const { t } = useTranslation();
  const { sessionId, error, now } = observation;
  const running = commands.findLast((command) => command.status === "running");
  const latest = running ?? commands.at(-1);
  if (!sessionId || (!latest && !error)) return null;
  return (
    <section className="my-2 min-w-0 shrink-0 rounded border px-3 py-2" data-testid="terminal-observation-content"
      aria-label={t("terminalObservation.title")}>
      <div role={error ? "alert" : "status"} data-testid="terminal-observation-live-strip"
        className={cn("flex min-w-0 items-center gap-2 rounded-md bg-agent/(--opacity-subtle) px-2.5 py-1.5 text-[11px] text-agent",
          error && "bg-destructive/(--opacity-subtle) text-destructive")}>
        {!error ? <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-current", running && "motion-safe:animate-pulse")} /> : null}
        <span className="shrink-0 font-medium" data-testid="terminal-observation-status">
          {error ? t(error === "resync-required" ? "terminalObservation.resyncRequired" : "terminalObservation.error")
            : t(running ? "terminalObservation.running" : "terminalObservation.completed")}
        </span>
        {!error && latest ? <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate font-mono" title={latest.command} data-testid="terminal-observation-command">{latest.command}</span>
          <span className="ml-auto shrink-0 font-mono" data-testid="terminal-observation-duration">· {elapsedSeconds(latest, now)}s</span>
        </> : null}
      </div>
      {!error ? <ol className="mt-1 max-h-44 overflow-y-auto" data-testid="terminal-observation-commands">
        {commands.map((command) => <li key={command.id} className={cn("min-w-0 border-b border-l-4 pl-2 last:border-b-0", command.sandbox.mode === "unconfined" ? "border-l-primary" : "border-l-agent")}>
          <span className={cn("mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium", command.sandbox.mode === "unconfined" ? "bg-primary/(--opacity-subtle) text-primary" : "bg-agent/(--opacity-subtle) text-agent")}
            data-testid={command.sandbox.mode === "unconfined" ? "terminal-approved-host-identity" : "terminal-isolated-identity"}>
            {t(command.sandbox.mode === "unconfined" ? "terminalObservation.approvedHostLabel" : "terminalObservation.isolatedLabel")}
          </span>
          <details className="group py-1" data-testid="terminal-observation-command-row" data-command-id={command.id}>
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-[11px] marker:hidden">
              <span aria-hidden="true" className="text-muted-foreground">›</span>
              <span className="min-w-0 flex-1 truncate font-mono" title={command.command}>{command.command}</span>
              {command.outputAvailability === "withheld-user-input"
                ? <span className="shrink-0 text-muted-foreground" data-testid="terminal-observation-withheld-marker">{t("terminalObservation.outputWithheldShort")}</span> : null}
              <span className="shrink-0 text-muted-foreground">{t(`terminalObservation.status.${command.status}`)}</span>
              <span className="shrink-0 font-mono text-muted-foreground">{elapsedSeconds(command, now)}s</span>
              <span className="flex w-full min-w-0 gap-2 pl-3 text-[10px] text-muted-foreground">
                <span className="min-w-0 flex-1 truncate font-mono" title={command.cwd} data-testid="terminal-observation-cwd">{command.cwd}</span>
                <span>{t("terminalObservation.exitCode", { code: command.exitCode === null ? t("terminalObservation.unknown") : command.exitCode })}</span>
              </span>
            </summary>
            <div className="space-y-1 pb-1 pl-3 text-[10px] text-muted-foreground">
              <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                <span>{t(`terminalObservation.sandbox.${command.sandbox.mode}`)}</span>
                {command.outputAvailability === "on-completion" ? <span>{t("terminalObservation.outputOnCompletion")}</span> : null}
              </div>
              {command.sandbox.detail ? <div className="break-words">{command.sandbox.detail}</div> : null}
              {command.outputAvailability === "withheld-user-input"
                ? <p className="break-words" data-testid="terminal-observation-withheld">{t("terminalObservation.outputWithheldUserInput")}</p> : null}
              {command.outputTail ? <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/(--opacity-medium) p-1.5 font-mono text-[10px] text-foreground"
                data-testid="terminal-observation-output">{command.outputTail}</pre> : null}
              {command.outputTruncated ? <p>{t("terminalObservation.outputTruncated")}</p> : null}
              {command.decisions.length > 0 ? <ul className="space-y-0.5" data-testid="terminal-observation-decisions">
                {command.decisions.map((decision, index) => {
                  const labels = decisionMessageKeys(decision);
                  return <li key={`${decision.ts}:${index}`} className="break-words">
                    {t(`terminalObservation.egress.${decision.decision}`)} · <span className="font-mono">{decision.host}{decision.port === null ? "" : `:${decision.port}`}</span>
                    {" · "}{t(decision.attribution === "terminal-session" ? "terminalObservation.terminalSessionScope" : "terminalObservation.commandScope")}
                    <div className="flex flex-wrap gap-x-2">
                      <span data-testid="terminal-observation-decision-basis">{t("terminalObservation.decisionBasis", { basis: t(labels.basis) })}</span>
                      <span data-testid="terminal-observation-decision-scope">{t("terminalObservation.decisionScope", { scope: t(labels.scope) })}</span>
                    </div>
                    {decision.reason ? <p>{decision.reason}</p> : null}
                  </li>;
                })}
              </ul> : null}
            </div>
          </details>
        </li>)}
      </ol> : null}
    </section>
  );
}
