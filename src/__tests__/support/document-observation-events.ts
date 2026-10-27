import { act } from "@testing-library/react";
import type { DocumentObservationEvent } from "../../shared/agent-observation.js";

export async function emitDocumentObservations(
  handlers: ReadonlySet<(events: DocumentObservationEvent[]) => void>,
  ...events: DocumentObservationEvent[]
): Promise<void> {
  await act(async () => { handlers.forEach((handler) => handler(events)); });
}
