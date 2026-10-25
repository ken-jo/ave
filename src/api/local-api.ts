// External dispatch shares renderer handlers but requires the public allowlist and gesture policy.
// Allowlisted mutations require in-app consent before reaching a handler.
import {
  CHANNELS,
  PERMISSIONS,
  CHANNEL_GESTURE,
  isPublicChannel,
  EXTERNAL_MUTATION_CHANNELS,
  EXTERNAL_MUTATION_DENIED,
  type PublicChannel,
  type ExternalMutationChannel,
} from "../contract/app-contract.js";
import { isExternalOrigin, type ExternalOrigin } from "../contract/trust-origin.js";
import type { IpcDeps } from "../ipc/types.js";
import {
  LOOPBACK_CONVERSATION_ACTOR,
  type ConversationCommandPort,
} from "../main/conversation-command-port.js";
import {
  handleChatSessions,
  handleChatGetHistory,
  handleChatSessionHistory,
} from "../ipc/handlers/chat.js";
import { handlePluginCards } from "../ipc/handlers/plugins.js";
import { handleGetMode, handleSetPermissionMode } from "../ipc/handlers/permissions.js";
import { handleUsageSummary, handleUsageRange } from "../ipc/handlers/usage.js";

export const LOCAL_API_CHANNEL_NOT_PUBLIC = "channel-not-public";
export const LOCAL_API_GESTURE_REQUIRED = "gesture-required-origin-unsupported";
export const LOCAL_API_ORIGIN_UNSUPPORTED = "origin-unsupported";

export type LocalApiErrorCode =
  | typeof LOCAL_API_CHANNEL_NOT_PUBLIC
  | typeof LOCAL_API_GESTURE_REQUIRED
  | typeof LOCAL_API_ORIGIN_UNSUPPORTED
  // Denial, timeout, and approval errors all reject the external mutation.
  | typeof EXTERNAL_MUTATION_DENIED;

export interface LocalApiRequest {
  channel: string;
  /** The channel's argument payload (shape validated by the target handler). */
  args?: unknown;
  origin: Exclude<ExternalOrigin, never>;
}

// Transport clients may extend failure codes; in-process results retain the narrower default union.
export type LocalApiResult<E extends string = LocalApiErrorCode> =
  | { ok: true; data: unknown }
  | { ok: false; error: E };

// Only true authorizes an allowlisted mutation; false or rejected approval fails closed.
export type ExternalMutationApprover = (req: {
  channel: ExternalMutationChannel;
  args: unknown;
  origin: ExternalOrigin;
}) => Promise<boolean>;

export interface LocalApiDeps {
  ipc: IpcDeps;
  /**
   * Host-owned command entrypoint. It binds this transport to the
   * non-privileged `surface-user` chat provenance before a turn starts.
   */
  conversationCommandPort: ConversationCommandPort;
  // Without an approver, reject every gesture-gated channel; with one, only allowlisted mutations may prompt.
  externalMutationApprover?: ExternalMutationApprover;
}

export interface LocalApi<E extends string = LocalApiErrorCode> {
  dispatch(req: LocalApiRequest): Promise<LocalApiResult<E>>;
}

function isExternalMutationChannel(channel: string): channel is ExternalMutationChannel {
  return (EXTERNAL_MUTATION_CHANNELS as readonly string[]).includes(channel);
}

export function createLocalApi(deps: LocalApiDeps): LocalApi {
  const { ipc, conversationCommandPort, externalMutationApprover } = deps;

  // External consent bypasses only the duplicate prompt; changes remain session-scoped and cannot select allow mode.
  // The handler validates the mode; EXTERNAL_CHANNEL_FORBIDDEN_MODES defines the forbidden choices.
  async function routeExternalMutation(
    channel: ExternalMutationChannel,
    args: unknown,
    origin: ExternalOrigin,
  ): Promise<unknown> {
    switch (channel) {
      case PERMISSIONS.setMode:
        // Wire contract is exactly `{mode}` — a bare or mis-shaped payload falls
        // through as `undefined` and the handler rejects it with `invalid-mode`.
        return handleSetPermissionMode(
          ipc,
          (args as { mode?: unknown } | undefined)?.mode,
          { source: "local-api-approval", trustOrigin: origin, explicitUserAction: true },
        );
      default: {
        const _exhaustive: never = channel;
        return _exhaustive;
      }
    }
  }

  function route(channel: PublicChannel, args: unknown): unknown {
    switch (channel) {
      case CHANNELS.chat.send:
        return conversationCommandPort.execute(LOOPBACK_CONVERSATION_ACTOR, {
          kind: "message.send",
          payload: args,
        });
      case CHANNELS.chat.sessions:
        return handleChatSessions(ipc, args as Parameters<typeof handleChatSessions>[1]);
      case CHANNELS.chat.getHistory:
        return handleChatGetHistory(ipc);
      case CHANNELS.chat.sessionHistory:
        return handleChatSessionHistory(ipc, args as string);
      case CHANNELS.plugins.cards:
        return handlePluginCards(ipc);
      case PERMISSIONS.getMode:
        return handleGetMode(ipc);
      case CHANNELS.usage.summary:
        return handleUsageSummary(args as Parameters<typeof handleUsageSummary>[0], ipc.auditLogger);
      case CHANNELS.usage.range:
        return handleUsageRange(args as Parameters<typeof handleUsageRange>[0], ipc.auditLogger);
      default: {
        const _exhaustive: never = channel;
        return _exhaustive;
      }
    }
  }

  async function dispatch(req: LocalApiRequest): Promise<LocalApiResult> {
    const { channel, args, origin } = req;

    // Validate origins at runtime; a bad cast must not smuggle renderer authority into this boundary.
    if (!isExternalOrigin(origin)) {
      return { ok: false, error: LOCAL_API_ORIGIN_UNSUPPORTED };
    }

    // Check gesture policy before the public allowlist so callers receive the specific gated rejection.
    if (CHANNEL_GESTURE[channel] === "required") {
      // Allowlisted mutations require an installed approver and an explicit true result.
      if (isExternalMutationChannel(channel) && externalMutationApprover) {
        let approved: boolean;
        try {
          approved = await externalMutationApprover({ channel, args, origin });
        } catch {
          return { ok: false, error: EXTERNAL_MUTATION_DENIED };
        }
        if (!approved) {
          return { ok: false, error: EXTERNAL_MUTATION_DENIED };
        }
        const data = await routeExternalMutation(channel, args, origin);
        return { ok: true, data };
      }
      return { ok: false, error: LOCAL_API_GESTURE_REQUIRED };
    }

    if (!isPublicChannel(channel)) {
      return { ok: false, error: LOCAL_API_CHANNEL_NOT_PUBLIC };
    }

    try {
      const data = await route(channel, args);
      return { ok: true, data };
    } catch (error) {
      // Lease contention is a chat outcome payload, not an authorization error or transport failure.
      if (channel === CHANNELS.chat.send
        && error instanceof Error
        && error.message === "streaming-active") {
        return { ok: true, data: { error: "streaming-active" } };
      }
      throw error;
    }
  }

  return { dispatch };
}
