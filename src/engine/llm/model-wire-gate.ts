import { RetiredModelError } from "./retired-model-error.js";

/** Live retirement evidence for one route: the retired model id for the model about to be sent, or undefined. */
export type RetiredModelProbe = (model: string) => string | undefined;

/** For a transport whose destination has no listing that could prove retirement. A named choice, never an inline default. */
export const noRetirementEvidence: RetiredModelProbe = () => undefined;

type SendWrapper = (send: typeof fetch) => typeof fetch;

const deferredSendRebuilders = new WeakMap<typeof fetch, (wrapSend: SendWrapper) => typeof fetch>();

/**
 * A fetch that awaits before its network send (address validation, a token read) declares how to rebuild itself around
 * a wrapped send, so the retirement check runs after that wait instead of before it.
 */
export function declareDeferredSend(fetchImpl: typeof fetch, rebuild: (wrapSend: SendWrapper) => typeof fetch): void {
  deferredSendRebuilders.set(fetchImpl, rebuild);
}

/**
 * The fetch every model transport sends through. Each wire attempt, including a transport's own retries, rereads the
 * route's live retirement evidence immediately before the network send and is refused with {@link RetiredModelError}.
 */
export function gateModelFetch(
  fetchImpl: typeof fetch | undefined,
  getRetiredModelId: () => string | undefined,
): typeof fetch {
  const gateSend: SendWrapper = (send) => (input, init) => {
    const model = getRetiredModelId();
    return model === undefined ? send(input, init) : Promise.reject(new RetiredModelError(model));
  };
  const rebuild = fetchImpl ? deferredSendRebuilders.get(fetchImpl) : undefined;
  // Checked on entry as well, so a route already retired spends no address lookup or token read.
  if (rebuild) return gateSend(rebuild(gateSend));
  // The ambient fetch is read per request, as the SDK does when it is given none.
  return gateSend((input, init) => (fetchImpl ?? globalThis.fetch)(input, init));
}
