/** Recursive callable proxies support eager service traversal; getSessionId returns a string and ownKeys preserves service spreading. */
export function makeDeepProxy(serviceKeys: readonly (string | symbol)[]): unknown {
  const target = (): void => undefined;
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === "getSessionId") return () => "test-session-id";
      if (prop === "then") return undefined; // Never expose a thenable.
      if (prop === "toString" || prop === "valueOf") return () => "mock";
      if (prop === Symbol.toPrimitive) return () => "mock";
      if (prop === Symbol.iterator || prop === Symbol.asyncIterator) return undefined;
      if (prop === Symbol.toStringTag) return undefined;
      return proxy;
    },
    apply() {
      return proxy;
    },
    ownKeys() {
      return serviceKeys as (string | symbol)[];
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true, writable: true, value: proxy };
    },
    has() {
      return true;
    },
  });
  return proxy;
}
