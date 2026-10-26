/** All surfaces share one mutable main loop and must acquire its process-wide lease. */

interface ConversationActivityTransitionLease {
  readonly owner: Promise<unknown> | null;
  // Reopen admission only after cleanup and session commit finish.
  release(): void;
}

export interface ConversationActivityCoordinator {
  allocateStreamId(): number;
  // Includes every state in which mutating the shared main loop would be unsafe.
  isBusy(): boolean;
  activeTurn(): Promise<unknown> | null;
  /** Cancel the admitted lease, including preparation before the loop creates its controller. */
  abortActiveTurn(reason?: Error): void;
  activeMutation(): Promise<unknown> | null;
  /** Share the loop transition guard so every surface sees busy before cleanup yields.
   * Transition settlement must notify idle listeners even outside a coordinator lease. */
  bindSessionTransitionGuard(guard: () => boolean, onSettled: (notify: () => void) => () => void): () => void;
  /** Close admission synchronously, capture its owner, then let the caller drain before transition. */
  beginSessionTransitionAdmission(): ConversationActivityTransitionLease | null;
  /** Defer factory work until its exclusive lease is visible to re-entrant callers. */
  trackTurn<T>(factory: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Fail admission before a command mutates state, without constructing a rejected promise. */
  tryTrackTurn<T>(factory: (signal: AbortSignal) => Promise<T>): Promise<T> | null;
  trackMutation<T>(factory: () => Promise<T>): Promise<T> | null;
  /** Notify after the turn lease clears so listeners can safely start the next turn. */
  onTurnSettled(listener: () => void): () => void;
  /** Subscribe before checking isBusy to avoid missing an idle transition.
   * Turns, mutations, admission release, and loop transitions can each produce idle. */
  onIdle(listener: () => void): () => void;
}

/** Share one transport-neutral coordinator while preserving caller-specific busy errors. */
export function createConversationActivityCoordinator(
  busyError = "streaming-active",
): ConversationActivityCoordinator {
  let nextStreamId = 0;
  let activeTurn: Promise<unknown> | null = null;
  let activeTurnController: AbortController | null = null;
  let activeMutation: Promise<unknown> | null = null;
  let activeSessionTransitionAdmission: object | null = null;
  let sessionTransitionGuard: (() => boolean) | null = null;
  const turnSettledListeners = new Set<() => void>();
  const idleListeners = new Set<() => void>();
  let unsubscribeSettled: (() => void) | null = null;

  const notifyTurnSettled = (): void => {
    for (const listener of turnSettledListeners) listener();
  };

  const isSessionTransitioning = (): boolean => sessionTransitionGuard?.() ?? false;

  const isBusy = () => activeSessionTransitionAdmission !== null
    || isSessionTransitioning()
    || activeTurn !== null
    || activeMutation !== null;

  const notifyIfIdle = (): void => {
    if (isBusy()) return;
    for (const listener of [...idleListeners]) listener();
  };

  const allocateStreamId = () => {
    if (nextStreamId >= Number.MAX_SAFE_INTEGER) {
      throw new Error("stream-id-exhausted");
    }
    nextStreamId += 1;
    return nextStreamId;
  };

  const tryTrackTurn = <T>(factory: (signal: AbortSignal) => Promise<T>): Promise<T> | null => {
    if (isBusy()) return null;
    const controller = new AbortController();
    const lease = Promise.resolve().then(() => factory(controller.signal)).finally(() => {
      if (activeTurn === lease) {
        activeTurn = null;
        activeTurnController = null;
      }
      notifyTurnSettled();
      notifyIfIdle();
    });
    activeTurn = lease;
    activeTurnController = controller;
    return lease;
  };

  const trackTurn = <T>(factory: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    tryTrackTurn(factory) ?? Promise.reject(new Error(busyError));

  const trackMutation = <T>(factory: () => Promise<T>): Promise<T> | null => {
    if (isBusy()) return null;
    const lease = Promise.resolve().then(factory).finally(() => {
      if (activeMutation === lease) activeMutation = null;
      notifyIfIdle();
    });
    activeMutation = lease;
    return lease;
  };

  return {
    allocateStreamId,
    isBusy,
    activeTurn: () => activeTurn,
    abortActiveTurn: (reason = new Error("user cancelled turn")) => activeTurnController?.abort(reason),
    activeMutation: () => activeMutation,
    bindSessionTransitionGuard: (guard: () => boolean, onSettled: (notify: () => void) => () => void) => {
      unsubscribeSettled?.();
      sessionTransitionGuard = guard;
      const unsubscribe = onSettled(notifyIfIdle);
      unsubscribeSettled = unsubscribe;
      return () => {
        if (sessionTransitionGuard === guard) sessionTransitionGuard = null;
        if (unsubscribeSettled === unsubscribe) unsubscribeSettled = null;
        unsubscribe();
        notifyIfIdle();
      };
    },
    beginSessionTransitionAdmission: () => {
      if (activeSessionTransitionAdmission !== null) return null;
      const token = Object.freeze({});
      const owner = activeTurn ?? activeMutation;
      activeSessionTransitionAdmission = token;
      return Object.freeze({
        owner,
        release: () => {
          if (activeSessionTransitionAdmission === token) activeSessionTransitionAdmission = null;
          notifyIfIdle();
        },
      });
    },
    trackTurn,
    tryTrackTurn,
    trackMutation,
    onTurnSettled: (listener: () => void) => {
      turnSettledListeners.add(listener);
      return () => turnSettledListeners.delete(listener);
    },
    onIdle: (listener: () => void) => {
      idleListeners.add(listener);
      return () => idleListeners.delete(listener);
    },
  };
}
