import { vi } from "vitest";
import type { ApprovalAnswerer, ApprovalDecision, ApprovalRequest } from "../../permissions/approval-gate.js";

type TestAnswer = Omit<ApprovalDecision, "requestId"> & { requestId?: string };

let answerSequence = 0;

/** Answer through a real gate's resolve, so the decision carries the gate's record of who answered. */
export async function answeredApprovalDecision(decision: TestAnswer, answeredBy: ApprovalAnswerer = "desk"): Promise<ApprovalDecision> {
  // Imported at call time so the record lands in the same module graph as the code under test, after vi.resetModules.
  const { ApprovalGate } = await import("../../permissions/approval-gate.js");
  const surface = { isDestroyed: () => false, send: vi.fn() };
  const gate = new ApprovalGate(surface as never);
  const id = decision.requestId ?? `answered-${++answerSequence}`;
  void gate.requestAndWait({ id, category: "tool", toolName: "answer", args: {}, reason: "Answer a test approval", source: "builtin", createdAt: Date.now() });
  const card = surface.send.mock.calls[0]?.[1] as ApprovalRequest | undefined;
  if (card?.nonce === undefined || card.hmac === undefined) throw new Error("answering gate did not issue a sealed card");
  const answered = gate.resolve(id, { ...decision, requestId: id, nonce: card.nonce, hmac: card.hmac }, answeredBy);
  if (answered?.choice !== decision.choice) throw new Error("answering gate did not accept the test answer");
  return answered;
}

/** A requestAndWait spy whose every answer goes through a real gate. */
export function answeringRequestAndWait<Request extends { id: string }>(
  answer: (request: Request) => TestAnswer | Promise<TestAnswer>,
  answeredBy: ApprovalAnswerer = "desk",
) {
  return vi.fn(async (request: Request) => answeredApprovalDecision({ requestId: request.id, ...await answer(request) }, answeredBy));
}
