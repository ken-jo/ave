/** A request was refused because live evidence shows its model is retired. Never give it a `cause`: transports read causes as network failures. */
export class RetiredModelError extends Error {
  constructor(readonly model: string) {
    super("The model is retired");
    this.name = "RetiredModelError";
  }
}

/** The retirement refusal inside an error a transport wrapped while retrying, if there is one. */
export function findRetiredModelError(error: unknown): RetiredModelError | undefined {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof RetiredModelError) return current;
    const { cause, lastError, errors } = current as { cause?: unknown; lastError?: unknown; errors?: unknown };
    pending.push(cause, lastError);
    if (Array.isArray(errors)) pending.push(...errors);
  }
  return undefined;
}
