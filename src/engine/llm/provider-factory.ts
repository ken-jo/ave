/**
 * API provider factory. OpenAI shares request policy with its subscription
 * connection; every API connection retains the same lazy SDK wire transport.
 *
 * The Vercel adapter pulls in 5 `@ai-sdk/*` packages plus `ai` — together the
 * single largest dead weight on main-process cold start when reviewer mode
 * is `rule`/`disabled` or no API key is configured. To keep `createProvider`
 * cheap at call time we return a thin lazy proxy whose `streamTurn` awaits
 * the adapter module on first use; subsequent calls share the cached module.
 */
import type {
  LLMProvider,
  LLMVendor,
  ProviderConfig,
  StreamEvent,
  StreamTurnParams,
} from "./types.js";
import { createOpenAiProvider } from "./openai/provider.js";

let adapterModuleP: Promise<typeof import("./vercel/adapter.js")> | null = null;
function loadAdapterModule(): Promise<typeof import("./vercel/adapter.js")> {
  if (!adapterModuleP) {
    adapterModuleP = import("./vercel/adapter.js").catch((err) => {
      adapterModuleP = null;
      throw err;
    });
  }
  return adapterModuleP;
}

class LazyVercelProvider implements LLMProvider {
  readonly vendor: LLMVendor;
  private innerP: Promise<LLMProvider> | null = null;
  constructor(private readonly config: ProviderConfig) {
    this.vendor = config.vendor;
  }
  private getInner(): Promise<LLMProvider> {
    if (!this.innerP) {
      const cfg = this.config;
      const baseUrl = cfg.baseUrl;
      this.innerP = loadAdapterModule()
        .then(({ VercelUnifiedProvider }) => {
          const args = [
            cfg.vendor,
            cfg.apiKey,
            baseUrl,
            cfg.fetch,
            {
              vertexProject: cfg.vertexProject,
              vertexLocation: cfg.vertexLocation,
              ...(cfg.openaiWire ? { openaiWire: cfg.openaiWire } : {}),
              ...(cfg.wire ? { wire: cfg.wire } : {}),
            },
          ] as const;
          return cfg.providerMetadata
            ? new VercelUnifiedProvider(...args, cfg.providerMetadata)
            : new VercelUnifiedProvider(...args);
        })
        .catch((err) => {
          this.innerP = null;
          throw err;
        });
    }
    return this.innerP;
  }
  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const inner = await this.getInner();
    yield* inner.streamTurn(params);
  }
}

/** The bare lazy SDK wire, for a connection that owns its own request policy (ChatGPT plan usage). */
export function createVercelTransport(config: ProviderConfig): LLMProvider {
  return new LazyVercelProvider(config);
}

export function createProvider(config: ProviderConfig): LLMProvider {
  const transport = new LazyVercelProvider(config);
  return config.vendor === "openai"
    ? createOpenAiProvider({ kind: "api-key", transport })
    : transport;
}

export function secretKeyFor(vendor: LLMVendor): string {
  return `llm.apiKey.${vendor}`;
}
