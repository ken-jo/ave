import { act } from "@testing-library/react";

/** Deliver one observation batch to every subscribed renderer handler inside React's act scope. */
export async function emitObservations<Event>(
  handlers: ReadonlySet<(events: Event[]) => void>,
  ...events: Event[]
): Promise<void> {
  await act(async () => { handlers.forEach((handler) => handler(events)); });
}
