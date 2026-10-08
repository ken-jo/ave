/**
 * Main-conversation execution coordinator.
 *
 * The current host owns one mutable main ConversationLoop. Every surface
 * therefore has to acquire the same turn or session-mutation lease before it
 * touches that loop. This deliberately stays transport-neutral: Electron,
 * loopback API, a future CLI, and a future remote adapter can all use the same
 * coordinator without gaining a second execution path.
 *
 * Per-session actors are a later evolution once the host owns independent
 * ConversationLoop instances. Until then, a process-wide coordinator is the
 * honest representation of the runtime's concurrency model.
 */

interface ConversationActivityTransitionLease {
  /** Owner active at the instant surface admission closed. */
  readonly owner: Promise<unknown> | null;
  /** Reopen surface admission after cleanup and session commit finish. */
  release(): void;
}

export interface ConversationActivityCoordinator {
  /** Allocate a process-wide stream correlation id for legacy render adapters. */
  allocateStreamId(): number;
  /** True while the active main ConversationLoop cannot be mutated safely. */
  isBusy(): boolean;
  /** The current turn lease, when one exists. */
  activeTurn(): Promise<unknown> | null;
  /** The current session-mutation lease, when one exists. */
  activeMutation(): Promise<unknown> | null;
  /**
   * Bind the synchronous session-transition admission guard for this runtime.
   *
   * ConversationLoop owns the generation boundary while this coordinator
   * owns surface turns and mutations. Binding the loop's transition state
   * here gives both paths one admission decision: once a transition begins,
   * every surface observes busy before any cleanup await can yield.
   * `onSettled` subscribes to the loop's transitions ending, so
   * {@link onIdle} hears a transition that ends outside every lease.
   */
  bindSessionTransitionGuard(guard: () => boolean, onSettled: (notify: () => void) => () => void): () => void;
  /**
   * Synchronously close surface admission and capture the existing owner.
   * The caller aborts when appropriate, drains `owner`, then acquires the
   * ConversationLoop transition lease. Returns null if already sealed.
   */
  beginSessionTransitionAdmission(): ConversationActivityTransitionLease | null;
  /**
   * Acquire the exclusive turn lease before running `factory`.
   *
   * The factory is deferred so the lease is observable before any synchronous
   * work can re-enter the runtime.
   */
  trackTurn<T>(factory: () => Promise<T>): Promise<T>;
  /**
   * Try to acquire the exclusive turn lease without synthesizing a rejected
   * promise. Command handlers that must change state before starting a turn use
   * this to fail before mutating state.
   */
  tryTrackTurn<T>(factory: () => Promise<T>): Promise<T> | null;
  /**
   * Acquire the exclusive session-mutation lease, or return null when a turn
   * or another mutation already owns the main conversation.
   */
  trackMutation<T>(factory: () => Promise<T>): Promise<T> | null;
  /**
   * Subscribe to "this conversation's turn lease has just been released".
   *
   * A turn reaches the provider through several entry points (the send
   * command port, the replay paths, the sub-agent wake), but every one of them
   * holds THIS lease while it runs — so the release is the single place that
   * means "a turn ended here". Listeners run after the lease is cleared, so a
   * listener may start the next turn without racing its own predecessor.
   */
  onTurnSettled(listener: () => void): () => void;
  /**
   * Subscribe to "the main conversation has just become idle": fired
   * whenever {@link isBusy} becomes false from any of its four conditions —
   * a turn settling, a mutation completing, a transition admission released,
   * or a session transition ending. Listeners run after the condition is
   * cleared. A subscriber that must not miss an idle moment subscribes first
   * and then rechecks `isBusy()` (the marketplace's apply queue, design
   * §18.7.4).
   */
  onIdle(listener: () => void): () => void;
}

/**
 * Build the v1 coordinator shared by every adapter for the active main
 * conversation. `busyError` preserves the existing IPC/public API error
 * contract while keeping the coordinator itself independent of a transport.
 */
export function createConversationActivityCoordinator(
  busyError = "streaming-active",
): ConversationActivityCoordinator {
  let nextStreamId = 0;
  let activeTurn: Promise<unknown> | null = null;
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

  /** Tell the idle listeners, when nothing keeps the conversation busy any more. */
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

  const tryTrackTurn = <T>(factory: () => Promise<T>): Promise<T> | null => {
    if (isBusy()) return null;
    const lease = Promise.resolve().then(factory).finally(() => {
      if (activeTurn === lease) activeTurn = null;
      notifyTurnSettled();
      notifyIfIdle();
    });
    activeTurn = lease;
    return lease;
  };

  const trackTurn = <T>(factory: () => Promise<T>): Promise<T> =>
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
