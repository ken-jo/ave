import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { openFeatureNamespace } from "../storage/feature-namespace.js";
import type {
  SubscriptionRuntimeCapabilities,
  SubscriptionRuntimeNotice,
  SubscriptionRuntimeErrorCode,
  SubscriptionRuntimeModel,
  SubscriptionRuntimeStatus,
} from "../../shared/subscription-runtime.js";
import { DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES } from "../../shared/subscription-runtime.js";
import type { OpenOAuthLogin } from "../oauth-login.js";
import { createChatGptPlanFetch } from "./egress.js";
import { DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS } from "../subscription-attachment-input.js";
import { ChatGptPlanIdTokenVerifier } from "./id-token.js";
import { loadOrCreateChatGptPlanHostId } from "./host-id.js";
import { startChatGptPlanCallbackListener, type ChatGptPlanCallbackListener } from "./loopback.js";
import {
  ChatGptPlanSession,
  ChatGptPlanSessionError,
  type ChatGptPlanSecretStore,
  type ChatGptPlanSessionEvent,
  type ChatGptPlanSessionFailure,
} from "./session.js";

/**
 * The plan-usage runtime behind the `chatgpt-plan` subscription id. It owns
 * no process: the session signs in through an isolated window and a loopback
 * callback, keeps its record in the encrypted secret store, and every request
 * leaves through the host network stack behind the plan egress allowlist.
 */

/** Boot-time inputs. Without them the runtime is not configured and says so. */
export interface ChatGptPlanRuntimeDeps {
  readonly secrets: ChatGptPlanSecretStore;
  /** The host's network stack (proxy and trust store); never an ambient fetch. */
  readonly networkFetch: typeof fetch;
  readonly namespace?: FeatureNamespaceHandle;
  readonly startListener?: (expectedState: string) => Promise<ChatGptPlanCallbackListener>;
  readonly onEvent?: (event: ChatGptPlanSessionEvent) => void;
}

/**
 * Every Ave capability is governed by Ave itself on this route. Original images go natively on the Responses wire
 * within the same budget as the Codex runtime; whether the selected model accepts them is decided per model (the
 * descriptor's `imageInputFollowsModelOf`, and the adapter's vision gate on send). Files use Ave's file marker and
 * governed read tool, exactly as on the API-key route.
 */
const CHATGPT_PLAN_CAPABILITIES: SubscriptionRuntimeCapabilities = Object.freeze({
  chat: true,
  images: true,
  imageAttachmentLimits: DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS,
  files: true,
  tools: true,
  projectAccess: true,
  plugins: true,
  mcp: true,
  generateText: true,
  compaction: true,
  routine: true,
  subagent: true,
});

export class ChatGptPlanRuntimeError extends Error {
  constructor(readonly code: SubscriptionRuntimeErrorCode) {
    super(`chatgpt-plan runtime: ${code}`);
    this.name = "ChatGptPlanRuntimeError";
  }
}

const SESSION_FAILURE_CODES: Readonly<Record<ChatGptPlanSessionFailure, SubscriptionRuntimeErrorCode>> = Object.freeze({
  "secure-storage-unavailable": "subscription-runtime-unavailable",
  "sign-in-in-progress": "subscription-login-in-progress",
  declined: "subscription-login-failed",
  "sign-in-failed": "subscription-login-failed",
  "account-mismatch": "subscription-login-failed",
  "signed-out": "subscription-chat-unavailable",
  "reconnect-required": "subscription-chat-unavailable",
  "plan-usage-disabled": "subscription-chat-unavailable",
  "temporarily-unavailable": "subscription-runtime-unavailable",
  "invalid-client": "subscription-operation-failed",
  "stored-record-invalid": "subscription-operation-failed",
});

/** The stable runtime code for a session failure; anything else is an operation failure. */
function chatGptPlanRuntimeErrorCode(error: unknown): SubscriptionRuntimeErrorCode {
  if (error instanceof ChatGptPlanRuntimeError) return error.code;
  if (error instanceof ChatGptPlanSessionError) return SESSION_FAILURE_CODES[error.failure];
  return "subscription-operation-failed";
}

function stable<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    throw new ChatGptPlanRuntimeError(chatGptPlanRuntimeErrorCode(error));
  });
}

export class ChatGptPlanRuntime {
  /** The egress-limited fetch every plan request uses, inference included. */
  readonly fetch: typeof fetch;

  constructor(private readonly session: ChatGptPlanSession, planFetch: typeof fetch) {
    this.fetch = planFetch;
  }

  /**
   * Project the session for the renderer. A sign-in whose grant lacks plan
   * usage is not a usable connection: it shows as signed out so "Continue
   * with ChatGPT" asks for the grant again, and chat stays unavailable.
   */
  getStatus(): SubscriptionRuntimeStatus {
    let status: ReturnType<ChatGptPlanSession["status"]>;
    try {
      status = this.session.status();
    } catch {
      // An unreadable stored record is reported, never replaced behind the user's back.
      return projectStatus("unavailable", "unknown", false);
    }
    const usable = status.connection === "connected" && status.planUsage === "enabled";
    const connection = status.connection === "connected" && !usable ? "signed-out" : status.connection;
    return projectStatus("ready", connection, usable, status.notice);
  }

  /** The user dismissed the card's notice (the welcome is shown once per install). */
  acknowledgeNotice(): SubscriptionRuntimeStatus {
    this.session.acknowledgeNotice();
    return this.getStatus();
  }

  async startLogin(): Promise<SubscriptionRuntimeStatus> {
    return stable(async () => {
      let requestConsent = false;
      try {
        requestConsent = this.session.status().planUsage === "disabled";
      } catch {
        throw new ChatGptPlanRuntimeError("subscription-operation-failed");
      }
      // The completion settles after the browser returns; the renderer polls the pending status meanwhile.
      await this.session.startSignIn(requestConsent ? { requestConsent: true } : {});
      return this.getStatus();
    });
  }

  cancelLogin(): SubscriptionRuntimeStatus {
    this.session.cancelSignIn();
    return this.getStatus();
  }

  async logout(): Promise<SubscriptionRuntimeStatus> {
    return stable(async () => {
      await this.session.signOut();
      return this.getStatus();
    });
  }

  async listModels(): Promise<{ status: SubscriptionRuntimeStatus; models: SubscriptionRuntimeModel[] }> {
    return stable(async () => {
      const models = await this.session.listModels();
      return {
        status: this.getStatus(),
        // The server's order is the account's order; there is no runtime default to mark.
        models: models.map((model) => ({ id: model.id, displayName: model.displayName, isDefault: false })),
      };
    });
  }

  /** A current access token for inference; refreshed and serialized by the session. */
  accessToken(): Promise<string> {
    return stable(() => this.session.accessToken());
  }

  /** Refresh once to learn whether a rejected subscriber context ended the session. */
  confirmSession(): Promise<void> {
    return stable(() => this.session.confirmSession());
  }

  stop(): void {
    this.session.cancelSignIn();
  }
}

function projectStatus(
  runtime: SubscriptionRuntimeStatus["runtime"],
  connection: SubscriptionRuntimeStatus["connection"],
  usable: boolean,
  notice: SubscriptionRuntimeNotice | null = null,
): SubscriptionRuntimeStatus {
  return {
    notice,
    provider: "chatgpt-plan",
    runtime,
    connection,
    planType: null,
    pendingLogin: connection === "pending" ? "browser" : null,
    pendingDeviceCode: null,
    // The authorization URL carries an ID-token hint and is never kept for a re-open action.
    canOpenVerificationUrl: false,
    version: null,
    capabilities: usable ? CHATGPT_PLAN_CAPABILITIES : DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
  };
}

/** The status shown when boot supplied no secret store or network stack. */
export function notConfiguredChatGptPlanStatus(): SubscriptionRuntimeStatus {
  return projectStatus("not-configured", "unknown", false);
}

export function createChatGptPlanRuntime(
  deps: ChatGptPlanRuntimeDeps,
  openAuthorizationUrl: OpenOAuthLogin,
): ChatGptPlanRuntime {
  const planFetch = createChatGptPlanFetch(deps.networkFetch);
  const namespace = deps.namespace ?? openFeatureNamespace("chatgpt-plan");
  let hostId: Promise<string> | null = null;
  const session = new ChatGptPlanSession({
    fetch: planFetch,
    secrets: deps.secrets,
    hostId: () => {
      hostId ??= loadOrCreateChatGptPlanHostId(namespace).catch((error: unknown) => {
        hostId = null;
        throw error;
      });
      return hostId;
    },
    openAuthorizationUrl,
    startListener: deps.startListener ?? ((expectedState) => startChatGptPlanCallbackListener(expectedState)),
    verifier: new ChatGptPlanIdTokenVerifier(planFetch),
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
  });
  return new ChatGptPlanRuntime(session, planFetch);
}

let configuredDeps: ChatGptPlanRuntimeDeps | null = null;

/** Called once at boot with the settings secret store and the host network stack. */
export function configureChatGptPlanRuntime(deps: ChatGptPlanRuntimeDeps): void {
  configuredDeps = deps;
}

export function configuredChatGptPlanRuntimeDeps(): ChatGptPlanRuntimeDeps | null {
  return configuredDeps;
}
