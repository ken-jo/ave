



import { ipcMain, type WebContents } from "electron";
import { broadcastToAppWindows } from "../window-fanout.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { createLogger } from "../../lib/logger.js";
import {
  DEFAULT_TOUR_STATE,
  readTourState,
  markScenarioComplete,
  dismissScenario,
  type TourState,
} from "../../main/tour-state-store.js";
import {
  isOnboardingProposalDisposition,
  pendingOnboardingProposals,
  readOnboardingProposalState,
  recordOnboardingProposalAnswer,
  type OnboardingProposalSource,
  type PendingOnboardingProposal,
} from "../../main/onboarding-proposal-store.js";
import { OVERLAY_V1 } from "../../shared/ipc-channels.js";
import { sendToWebContents } from "../safe-send.js";
import { DEFAULT_LOCALE } from "../../i18n/locale.js";
import type { IpcDeps } from "../types.js";
import { errorMessage } from "../../shared/error-message.js";
import { resolvePluginDisplayName } from "../../shared/plugin-provenance.js";

const log = createLogger("tour-ipc");

export const TOUR_START_CHANNEL = CHANNELS.tour.start;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Bound proposal keys before they become persisted object keys.
const PROPOSAL_KEY_PATTERN = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;
const PROPOSAL_KEY_MAX_LENGTH = 200;

const LOCALE_TAG_MAX_LENGTH = 35;

function readLocale(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= LOCALE_TAG_MAX_LENGTH
    ? value
    : DEFAULT_LOCALE;
}

export function registerTourHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  // Persist later answers for the next launch; a registration-local set prevents reasking during this launch.
  const answeredThisLaunch = new Set<string>();

  // Stage one unanswered proposal at a time from state that includes prior answers.
  const stagePendingProposals = async (
    sender: WebContents,
    locale: string,
  ): Promise<PendingOnboardingProposal[]> => {
    const pluginCards = deps.pluginRuntime.listPluginCards(deps.toolRegistry);
    const sources: OnboardingProposalSource[] = pluginCards
      .flatMap((card) =>
        card.loadStatus === "loaded" && card.active === true && card.onboarding !== undefined
          ? [{ pluginId: card.id, onboarding: card.onboarding }]
          : [],
      );
    const state = await readOnboardingProposalState();
    const pending = pendingOnboardingProposals(sources, state, answeredThisLaunch, locale);
    const head = pending[0];
    if (head) {
      sendToWebContents(
        sender,
        OVERLAY_V1.show,
        {
          id: `proposal:${head.key}`,
          pluginDisplayName: resolvePluginDisplayName(
            head.pluginId,
            pluginCards.find((card) => card.id === head.pluginId)?.name,
          ),
          source: {
            kind: "proposal" as const,
            pluginId: head.pluginId,
            proposalId: head.proposalId,
            action: head.action,
          },
          title: head.headline,
          summary: head.body,
          running: false,
          primaryActionLabel: head.actionLabel,
          createdAt: new Date().toISOString(),
        },
        log,
      );
    }
    return pending;
  };

  ipcMain.handle(
    CHANNELS.onboarding.listPending,
    async (
      e,
      payload: { locale?: unknown },
    ): Promise<
      | { ok: true; pending: PendingOnboardingProposal[] }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.onboarding.listPending, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      try {
        const pending = await stagePendingProposals(e.sender, readLocale(payload?.locale));
        return { ok: true, pending };
      } catch (err) {
        log.error({ err: errorMessage(err) }, "list-pending failed");
        return {
          ok: false,
          error: "read-failed",
          message: err instanceof Error ? err.message : "unknown read failure",
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.onboarding.answer,
    async (
      e,
      payload: { key?: unknown; disposition?: unknown; locale?: unknown },
    ): Promise<
      | { ok: true; pending: PendingOnboardingProposal[] }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.onboarding.answer, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const key = payload?.key;
      if (
        !isNonEmptyString(key)
        || key.length > PROPOSAL_KEY_MAX_LENGTH
        || !PROPOSAL_KEY_PATTERN.test(key)
      ) {
        return {
          ok: false,
          error: "invalid-proposal-key",
          message: "key must be shaped <pluginId>:<proposalId>",
        };
      }
      const disposition = payload?.disposition;
      if (!isOnboardingProposalDisposition(disposition)) {
        return {
          ok: false,
          error: "invalid-disposition",
          message: "disposition must be accepted, never, or later",
        };
      }
      try {
        await recordOnboardingProposalAnswer(key, disposition);
        answeredThisLaunch.add(key);
        const pending = await stagePendingProposals(e.sender, readLocale(payload?.locale));
        return { ok: true, pending };
      } catch (err) {
        log.error({ err: errorMessage(err) }, "answer failed");
        return {
          ok: false,
          error: "write-failed",
          message: err instanceof Error ? err.message : "unknown write failure",
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.tour.getState,
    async (
      e,
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.getState, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      try {
        const state = await readTourState();
        return { ok: true, state };
      } catch (err) {
        log.warn(
          { err: errorMessage(err) },
          "read failed; falling back to default",
        );
        return { ok: true, state: DEFAULT_TOUR_STATE };
      }
    },
  );

  const handleScenarioMutation = (
    channel: typeof CHANNELS.tour.markComplete | typeof CHANNELS.tour.dismiss,
    mutate: (scenarioId: string) => Promise<TourState>,
    failureLog: string,
  ): void => {
    ipcMain.handle(
      channel,
      async (
        e,
        payload: { scenarioId?: unknown },
      ): Promise<
        | { ok: true; state: TourState }
        | { ok: false; error: string; message: string }
      > => {
        if (!validateHostRendererSender(e)) {
          auditUnauthorized(auditLogger, channel, e);
          return {
            ok: false,
            error: UNAUTHORIZED_FRAME.error,
            message: "sender frame is not authorized",
          };
        }
        const scenarioId = payload?.scenarioId;
        if (!isNonEmptyString(scenarioId)) {
          return {
            ok: false,
            error: "invalid-scenario-id",
            message: "scenarioId must be a non-empty string",
          };
        }
        try {
          const state = await mutate(scenarioId);
          return { ok: true, state };
        } catch (err) {
          log.error({ err: errorMessage(err) }, failureLog);
          return {
            ok: false,
            error: "write-failed",
            message: err instanceof Error ? err.message : "unknown write failure",
          };
        }
      },
    );
  };
  handleScenarioMutation(CHANNELS.tour.markComplete, markScenarioComplete, "mark-complete failed");
  handleScenarioMutation(CHANNELS.tour.dismiss, dismissScenario, "dismiss failed");

  ipcMain.handle(
    CHANNELS.tour.start,
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; scenarioId: string }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.start, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const scenarioId = payload?.scenarioId;
      if (!isNonEmptyString(scenarioId)) {
        return {
          ok: false,
          error: "invalid-scenario-id",
          message: "scenarioId must be a non-empty string",
        };
      }
      // Use shared renderer fan-out so destroyed windows and send races cannot block peers.
      broadcastToAppWindows(deps, TOUR_START_CHANNEL, { scenarioId }, { logger: log });
      return { ok: true, scenarioId };
    },
  );

}
