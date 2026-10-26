import type { SubscriptionChatRuntimeSelection } from "../../../shared/subscription-runtime.js";
import type {
  LLMProvider,
  ProviderRequestInputProjection,
  ProviderRequestInputProjectionParams,
  StreamEvent,
  StreamTurnParams,
} from "../types.js";
import { projectOpenAiMessages, projectOpenAiTools } from "./request.js";
import { estimateRequestInputProjection } from "../../request-input-projection.js";

type OpenAiTransport = Pick<LLMProvider, "streamTurn" | "projectRequestInput" | "listSubscriptionModels">;

export type OpenAiProviderConnection =
  | {
      /** API credentials and request-owned reasoning/output options remain in the transport. */
      kind: "api-key";
      transport: OpenAiTransport;
    }
  | {
      /** Native reasoning stays profile-owned; thinking hints remain prompt content only. */
      kind: "codex-subscription";
      selection: SubscriptionChatRuntimeSelection & { provider: "codex" };
      transport: OpenAiTransport;
    }
  | {
      /** Sign in with ChatGPT plan usage: Ave's OAuth session on the Responses wire, no CLI and no API key. */
      kind: "chatgpt-plan";
      selection: SubscriptionChatRuntimeSelection & { provider: "chatgpt-plan" };
      transport: OpenAiTransport;
    };

/** Shared request policy with separately owned authentication and wire protocols. */
export class OpenAiProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly subscriptionRuntime?: SubscriptionChatRuntimeSelection;
  private readonly transport: OpenAiTransport;
  private readonly connectionKind: OpenAiProviderConnection["kind"];

  constructor(connection: OpenAiProviderConnection) {
    this.transport = connection.transport;
    this.connectionKind = connection.kind;
    if (connection.kind !== "api-key") {
      const provider = connection.kind === "codex-subscription" ? "codex" : "chatgpt-plan";
      if (connection.selection.kind !== "subscription" || connection.selection.provider !== provider) {
        throw new Error("invalid OpenAI subscription connection");
      }
      this.subscriptionRuntime = Object.freeze({
        kind: "subscription",
        provider,
        ...(connection.selection.model === undefined ? {} : { model: connection.selection.model }),
      });
    }
  }

  listSubscriptionModels(): Promise<readonly string[]> {
    if (this.connectionKind === "api-key" || !this.transport.listSubscriptionModels) {
      return Promise.reject(new Error("model catalog unavailable for this connection"));
    }
    return this.transport.listSubscriptionModels();
  }

  projectRequestInput(
    input: ProviderRequestInputProjectionParams,
  ): ProviderRequestInputProjection | undefined {
    const projected = {
      ...input,
      messages: projectOpenAiMessages(input.messages),
      toolSchemas: projectOpenAiTools(input.toolSchemas),
    };
    // Estimate the same prepared API input used for dispatch (API key and plan usage share the Responses/API wire); native envelopes own their estimator.
    return this.connectionKind !== "codex-subscription"
      ? estimateRequestInputProjection(projected, {
          vendor: this.vendor,
          projectRequestInput: this.transport.projectRequestInput?.bind(this.transport),
        })
      : this.transport.projectRequestInput?.(projected);
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    // Preserve model, controls, and signal; the connection owns their protocol meaning and provenance.
    yield* this.transport.streamTurn({
      ...params,
      messages: projectOpenAiMessages(params.messages),
      ...(params.tools === undefined ? {} : { tools: projectOpenAiTools(params.tools) }),
    });
  }
}

export function createOpenAiProvider(connection: OpenAiProviderConnection): OpenAiProvider {
  return new OpenAiProvider(connection);
}
