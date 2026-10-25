import type { PluginHostApi } from "./types.js";
import {
  HOSTAPI_EFFECT_BY_PATH,
  pathEffectClass,
} from "../permissions/effect-kind.js";
import type { PluginRuntimeGenerationAccess } from "./plugin-host-generation.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("plugin-host-effect-scope");

type ScopeState =
  | "preparing" | "published" | "superseded" | "discarded" | "retired";

const PREPARED_SUBSCRIPTIONS = new Set([
  "config.onChange",
  "onEvent",
  "onPluginsChanged",
  "onShutdown",
]);
const QUEUED_SIGNALS = new Set(["emitEvent", "logEvent"]);
const PREPARED_SIGNAL_LIMIT = 64;

interface GenerationBinding {
  access: PluginRuntimeGenerationAccess;
  generationId: string;
}

interface QueuedSignal {
  invoke(): void;
}

function preparationError(pluginId: string, path: string): Error {
  return new Error(
    `[plugin:${pluginId}] hostApi.${path} is unavailable while a replacement generation is preparing`,
  );
}

/** Explicit generation ownership survives callbacks scheduled after factory return. */
export class HostApiGenerationScope {
  readonly token = Object.freeze({});
  private state: ScopeState = "preparing";
  private binding: GenerationBinding | undefined;
  private readonly disposers = new Set<() => void>();
  private readonly queuedSignals: QueuedSignal[] = [];
  private readonly publishActions: Array<() => void> = [];
  private readonly supersedeActions: Array<() => void> = [];

  constructor(readonly pluginId: string) {}

  bindGeneration(
    access: PluginRuntimeGenerationAccess,
    generationId: string,
  ): void {
    if (this.binding)
      throw new Error(
        `plugin '${this.pluginId}' generation scope is already bound`,
      );
    if (this.state !== "preparing")
      throw new Error(
        `plugin '${this.pluginId}' generation scope is not preparing`,
      );
    this.binding = Object.freeze({ access, generationId });
  }

  publish(): void {
    this.preparePublish()();
  }

  preparePublish(): () => void {
    if (!this.binding)
      throw new Error(
        `plugin '${this.pluginId}' generation scope is not bound`,
      );
    if (this.state !== "preparing")
      throw new Error(
        `plugin '${this.pluginId}' generation scope cannot publish from ${this.state}`,
      );
    return () => {
      if (this.state !== "preparing") return;
      for (const action of this.publishActions) action();
      this.state = "published";
    };
  }

  resume(): void {
    if (!this.binding)
      throw new Error(
        `plugin '${this.pluginId}' generation scope is not bound`,
      );
    if (this.state === "published") return;
    if (this.state !== "superseded") {
      throw new Error(
        `plugin '${this.pluginId}' generation scope cannot resume from ${this.state}`,
      );
    }
    for (const action of this.publishActions) action();
    this.state = "published";
  }

  supersede(): void {
    if (this.state !== "published") return;
    this.state = "superseded";
    for (const action of this.supersedeActions) action();
  }

  isPreparing(): boolean {
    return this.state === "preparing";
  }

  stagePublish(action: () => void): void {
    if (this.state === "preparing") {
      this.publishActions.push(action);
      return;
    }
    if (this.state === "published") {
      action();
      return;
    }
    throw new Error(
      `plugin '${this.pluginId}' generation scope cannot publish effects from ${this.state}`,
    );
  }

  onSupersede(action: () => void): void {
    if (this.state === "preparing" || this.state === "published") {
      this.supersedeActions.push(action);
      return;
    }
    if (this.state === "superseded") action();
  }

  postPublish(): readonly Error[] {
    if (this.state !== "published") return [];
    const errors: Error[] = [];
    for (const signal of this.queuedSignals.splice(0)) {
      try {
        signal.invoke();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return errors;
  }

  registerDisposer(dispose: () => void): void {
    if (this.state === "discarded" || this.state === "retired") {
      dispose();
      return;
    }
    this.disposers.add(dispose);
  }

  wrapCallback<TArgs extends readonly unknown[]>(
    callback: (...args: TArgs) => unknown,
  ): (...args: TArgs) => Promise<void> {
    return async (...args: TArgs): Promise<void> => {
      const binding = this.binding;
      if (this.state !== "published" || !binding) return;
      let lease;
      try {
        lease = await binding.access.acquireExact(
          this.pluginId,
          binding.generationId,
        );
      } catch {
        return;
      }
      try {
        await binding.access.runWithLease(lease, async () => {
          await callback(...args);
        });
      } finally {
        lease.release();
      }
    };
  }

  /** Contain failures from callbacks nobody awaits; choose this wrapper at the event-registration site. */
  wrapListener<TArgs extends readonly unknown[]>(
    callback: (...args: TArgs) => unknown,
  ): (...args: TArgs) => void {
    const wrapped = this.wrapCallback(callback);
    return (...args: TArgs): void => {
      void wrapped(...args).catch((error: unknown) => {
        log.warn(
          `[plugin:${this.pluginId}] host listener failed: %s`,
          errorMessage(error),
        );
      });
    };
  }

  wrapHostApi(hostApi: PluginHostApi): PluginHostApi {
    const cache = new WeakMap<object, object>();
    const wrapObject = (target: object, prefix: string): object => {
      const cached = cache.get(target);
      if (cached) return cached;
      const proxy = new Proxy(target, {
        get: (inner, property, receiver) => {
          const value = Reflect.get(inner, property, receiver) as unknown;
          if (typeof property !== "string") return value;
          const path = prefix ? `${prefix}.${property}` : property;
          if (typeof value === "function") {
            return (...args: unknown[]) =>
              this.invoke(
                path,
                value as (...innerArgs: unknown[]) => unknown,
                inner,
                args,
              );
          }
          if (value && typeof value === "object")
            return wrapObject(value, path);
          return value;
        },
      });
      cache.set(target, proxy);
      return proxy;
    };
    return wrapObject(hostApi, "") as PluginHostApi;
  }

  discard(): void {
    if (this.state === "published" || this.state === "superseded") {
      throw new Error(
        `plugin '${this.pluginId}' published generation scope cannot be discarded`,
      );
    }
    if (this.state === "discarded" || this.state === "retired") return;
    this.state = "discarded";
    this.queuedSignals.length = 0;
    this.publishActions.length = 0;
    this.supersedeActions.length = 0;
    this.disposeAll();
  }

  /** Retry only failed disposers; successful retirement effects must run once. */
  retire(): readonly Error[] {
    if (this.state !== "retired") {
      this.state = "retired";
      this.queuedSignals.length = 0;
      this.publishActions.length = 0;
      this.supersedeActions.length = 0;
    }
    return this.disposeAll({ keepFailed: true });
  }

  private invoke(
    path: string,
    method: (...args: unknown[]) => unknown,
    receiver: object,
    args: unknown[],
  ): unknown {
    if (this.state === "discarded" || this.state === "retired") {
      throw new Error(
        `[plugin:${this.pluginId}] hostApi.${path} belongs to a retired generation`,
      );
    }
    if (this.state === "superseded") {
      const binding = this.binding;
      if (
        !binding ||
        !binding.access.isExactAdmitted(this.pluginId, binding.generationId)
      ) {
        throw new Error(
          `[plugin:${this.pluginId}] hostApi.${path} belongs to a retired generation`,
        );
      }
      return method.apply(receiver, args);
    }
    if (this.state !== "preparing") return method.apply(receiver, args);

    if (PREPARED_SUBSCRIPTIONS.has(path)) return method.apply(receiver, args);
    if (QUEUED_SIGNALS.has(path)) {
      if (this.queuedSignals.length >= PREPARED_SIGNAL_LIMIT) {
        throw new Error(
          `[plugin:${this.pluginId}] prepared HostApi signal limit exceeded`,
        );
      }
      const clonedArgs = structuredClone(args);
      this.queuedSignals.push({
        invoke: () => {
          method.apply(receiver, clonedArgs);
        },
      });
      return undefined;
    }

    const effect = pathEffectClass(path);
    // Refuse every path absent from the effect table; UI callTool is not a HostApi member.
    if (effect === "write" || effect === "verb-derived" || !HOSTAPI_EFFECT_BY_PATH[path]) {
      throw preparationError(this.pluginId, path);
    }
    return method.apply(receiver, args);
  }

  private disposeAll(options: { keepFailed?: boolean } = {}): Error[] {
    const errors: Error[] = [];
    for (const dispose of [...this.disposers].reverse()) {
      try {
        dispose();
        this.disposers.delete(dispose);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        if (!options.keepFailed) this.disposers.delete(dispose);
      }
    }
    return errors;
  }
}
