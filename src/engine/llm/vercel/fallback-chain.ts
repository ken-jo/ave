import type { CustomProviderWire } from "../../../shared/custom-provider.js";
// Retry transient pre-stream failures only; auth, validation, cancellation, and partial output cannot fall back.
import type {
  LLMProvider,
  ProviderRequestInputProjection,
  ProviderRequestInputProjectionParams,
  StreamEvent,
  StreamTurnParams,
} from "../types.js";
import type { LLMVendor } from "../types.js";
import type { ProviderConfig } from "../types.js";
import type { SubscriptionChatRuntimeSelection } from "../../../shared/subscription-runtime.js";
import { createProvider as defaultCreateProvider } from "../provider-factory.js";
import { createLogger } from "../../../lib/logger.js";
import { sleep } from "../../../shared/abortable-deadline.js";
import { errorMessage } from "../../../shared/error-message.js";
import { estimateRequestInputProjection } from "../../request-input-projection.js";

const log = createLogger("fallback-chain");

export interface FallbackChainEntry {
  provider: LLMVendor;
  model: string;
  baseUrl?: string;
  wire?: CustomProviderWire;
  vertexProject?: string;
  vertexLocation?: string;
}

export interface FallbackCallbacks {
  onFallback?: (from: string, to: string) => void;
  onStatus?: (status: FallbackStatus) => void;
}

export interface FallbackStatus {
  phase: "attempt" | "retry" | "fallback";
  label?: string;
  provider?: LLMVendor;
  model?: string;
  attempt?: number;
  maxAttempts?: number;
  from?: string;
  to?: string;
  reason?: string;
}

const MIN_RETRY_WINDOW_MS = 1_000;
const MAX_ATTEMPTS_PER_PROVIDER = 5;

type ErrorStreamEvent = Extract<StreamEvent, { type: "error" }>;

// Preserve structured subscription error events for bounded engine recovery after transient retries.
class RetryableStreamEventError extends Error {
  constructor(readonly event: ErrorStreamEvent) {
    super(event.error);
    this.name = "RetryableStreamEventError";
  }
}

function isNonRetryable(err: unknown): boolean {
  // User cancellation must propagate without retries or fallback.
  if (err instanceof Error && err.name === "AbortError") return true;

  const msg = errorMessage(err);
  const lower = msg.toLowerCase();
  if (/\b(400|401|403|404)\b/.test(msg)) return true;
  if (/api_key|authentication|unauthorized|forbidden|invalid_model|model_not_found/.test(lower)) return true;
  if (/baseurl is required|project is required|location is required/.test(lower)) return true;
  return false;
}

function isNonRetryableStreamEvent(event: ErrorStreamEvent): boolean {
  // Deterministic request failures go straight to bounded schema/context recovery; 429 remains retryable.
  const classification = event.classification ?? event.providerError?.classification;
  const diagnosticClassification = event.providerError?.classification;
  if (
    classification === "api-key"
    || classification === "model"
    || classification === "context-length"
    || diagnosticClassification === "api-key"
    || diagnosticClassification === "model"
    || diagnosticClassification === "context-length"
  ) {
    return true;
  }
  const diagnostics = event.providerError;
  if (diagnostics?.isRetryable === false) return true;
  const status = diagnostics?.statusCode;
  return status !== undefined && status !== 429 && status >= 400 && status < 500;
}

// Only retryable first-event errors may enter fallback; later events pass through unchanged.
async function* attemptStream(
  provider: LLMProvider,
  params: StreamTurnParams,
): AsyncIterable<StreamEvent> {
  let firstEvent = true;
  for await (const ev of provider.streamTurn(params)) {
    if (firstEvent && ev.type === "error") {
      if (isNonRetryableStreamEvent(ev)) {
        yield ev;
        return;
      }
      // Retain the complete error event across retries without widening exposed provider text.
      throw new RetryableStreamEventError(ev);
    }
    firstEvent = false;
    yield ev;
  }
}

async function* attemptStreamWithRetries(
  provider: LLMProvider,
  params: StreamTurnParams,
  label: string,
  identity: { provider: LLMVendor; model: string },
  callbacks?: FallbackCallbacks,
): AsyncIterable<StreamEvent> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PROVIDER; attempt += 1) {
    throwIfAborted(params.abortSignal);
    const attemptStartedAt = Date.now();
    callbacks?.onStatus?.({
      phase: "attempt",
      label,
      provider: identity.provider,
      model: identity.model,
      attempt,
      maxAttempts: MAX_ATTEMPTS_PER_PROVIDER,
    });
    try {
      yield* attemptStream(provider, params);
      return;
    } catch (err) {
      throwIfAborted(params.abortSignal);
      if (isNonRetryable(err)) throw err;
      lastErr = err;
      await waitForAttemptWindow(attemptStartedAt, err, params.abortSignal);
      if (attempt >= MAX_ATTEMPTS_PER_PROVIDER) break;
      // Audit retries so slow or unstable gateways remain diagnosable.
      log.warn(`retry: ${label} attempt=${attempt + 1}/${MAX_ATTEMPTS_PER_PROVIDER} reason=${errorMessage(err)}`);
      callbacks?.onStatus?.({
        phase: "retry",
        label,
        provider: identity.provider,
        model: identity.model,
        attempt: attempt + 1,
        maxAttempts: MAX_ATTEMPTS_PER_PROVIDER,
        reason: errorMessage(err),
      });
    }
  }
  throw lastErr;
}

function makeAbortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) throw makeAbortError();
}

function waitForAttemptWindow(
  startedAt: number,
  _err: unknown,
  abortSignal?: AbortSignal,
): Promise<void> {
  const remainingMs = Math.max(0, MIN_RETRY_WINDOW_MS - (Date.now() - startedAt));
  if (abortSignal?.aborted) return Promise.reject(makeAbortError());
  if (remainingMs <= 0) return Promise.resolve();
  // Callers match AbortError by name rather than the signal reason.
  return sleep(remainingMs, abortSignal).catch(() => {
    throw makeAbortError();
  });
}

// Reuse the injected secret lookup only when constructing a needed fallback.
export type ApiKeyGetter = (vendor: LLMVendor) => string;
export type ProviderFactory = (config: ProviderConfig) => LLMProvider;

export class FallbackProvider implements LLMProvider {
  readonly vendor: LLMVendor;
  readonly subscriptionRuntime?: SubscriptionChatRuntimeSelection;
  readonly listSubscriptionModels?: () => Promise<readonly string[]>;
  constructor(
    private readonly primary: LLMProvider,
    private readonly chain: FallbackChainEntry[],
    private readonly getApiKey: ApiKeyGetter,
    private readonly factory?: ProviderFactory,
  ) {
    this.vendor = primary.vendor;
    this.subscriptionRuntime = primary.subscriptionRuntime;
    if (primary.listSubscriptionModels) {
      this.listSubscriptionModels = () => primary.listSubscriptionModels!();
    }
  }

  withCallbacks(callbacks: FallbackCallbacks): LLMProvider {
    return {
      vendor: this.vendor,
      ...(this.subscriptionRuntime ? { subscriptionRuntime: this.subscriptionRuntime } : {}),
      ...(this.listSubscriptionModels ? { listSubscriptionModels: this.listSubscriptionModels } : {}),
      projectRequestInput: (input) => this.projectRequestInput(input),
      streamTurn: (params) => this.streamTurnWithCallbacks(params, callbacks),
    };
  }

  projectRequestInput(
    input: ProviderRequestInputProjectionParams,
  ): ProviderRequestInputProjection | undefined {
    if (this.chain.length === 0) return this.primary.projectRequestInput?.(input);

    // Reserve the largest complete route projection, never sum mutually exclusive requests.
    let projection = estimateRequestInputProjection(input, this.primary);
    for (const entry of this.chain) {
      // Projection must not construct fallback providers or read their credentials.
      const candidate = estimateRequestInputProjection(input, { vendor: entry.provider });
      if (candidate.totalTokens > projection.totalTokens) projection = candidate;
    }
    return projection;
  }

  streamTurnWithCallbacks(
    params: StreamTurnParams,
    callbacks?: FallbackCallbacks,
  ): AsyncIterable<StreamEvent> {
    return streamWithFallback(
      this.primary,
      params,
      this.chain,
      this.getApiKey,
      this.factory,
      callbacks,
    );
  }

  streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    return this.streamTurnWithCallbacks(params);
  }
}

export async function* streamWithFallback(
  primary: LLMProvider,
  params: StreamTurnParams,
  chain: FallbackChainEntry[],
  getApiKey: ApiKeyGetter,
  _createProvider: ProviderFactory = defaultCreateProvider,
  callbacks?: FallbackCallbacks,
): AsyncIterable<StreamEvent> {
  // Construct fallback providers lazily after the primary attempt.
  const totalAttempts = 1 + chain.length;

  const getAttempt = (i: number): {
    provider: LLMProvider;
    label: string;
    identity: { provider: LLMVendor; model: string };
    attemptParams: StreamTurnParams;
  } => {
    if (i === 0) {
      return {
        provider: primary,
        label: `${primary.vendor}/${params.model}`,
        identity: { provider: primary.vendor, model: params.model },
        attemptParams: params,
      };
    }
    const entry = chain[i - 1]!;
    const apiKey = getApiKey(entry.provider);
    // Primary route limits and capabilities cannot be carried into fallback models.
    const {
      outputCeiling: _primaryCeiling,
      outputCeilingSource: _primaryCeilingSource,
      catalogModel: _primaryCatalogModel,
      modelCapabilities: _primaryCapabilities,
      ...fallbackParams
    } = params;
    return {
      provider: _createProvider({
        vendor: entry.provider,
        apiKey,
        model: entry.model,
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
        ...(entry.wire ? { wire: entry.wire } : {}),
        ...(entry.vertexProject ? { vertexProject: entry.vertexProject } : {}),
        ...(entry.vertexLocation ? { vertexLocation: entry.vertexLocation } : {}),
      }),
      label: `${entry.provider}/${entry.model}`,
      identity: { provider: entry.provider, model: entry.model },
      attemptParams: {
        ...fallbackParams,
        model: entry.model,
        ...(params.requestedOutputTokenLimit !== undefined ? { outputTokenLimit: params.requestedOutputTokenLimit } : {}),
      },
    };
  };

  let lastErr: unknown;
  for (let i = 0; i < totalAttempts; i++) {
    const { provider, label, identity, attemptParams } = getAttempt(i);
    try {
      throwIfAborted(params.abortSignal);
      yield* attemptStreamWithRetries(provider, attemptParams, label, identity, callbacks);
      return;
    } catch (err) {
      throwIfAborted(params.abortSignal);
      if (isNonRetryable(err)) throw err;
      lastErr = err;
      if (i + 1 >= totalAttempts) break;
      const nextEntry = chain[i];
      const nextLabel = nextEntry ? `${nextEntry.provider}/${nextEntry.model}` : "??";
      const reason = errorMessage(err);
      const msg = `fallback: ${label}→${nextLabel} reason=${reason}`;
      log.warn(`${msg}`);
      callbacks?.onFallback?.(label, nextLabel);
      callbacks?.onStatus?.({ phase: "fallback", from: label, to: nextLabel, reason });
    }
  }
  // Subscription retries never construct API-key fallbacks; retain the structured event on exhaustion.
  if (primary.subscriptionRuntime && lastErr instanceof RetryableStreamEventError) {
    yield lastErr.event;
    return;
  }
  throw lastErr;
}
