import { isValidSessionId } from "../shared/session-id.js";
import { parseWorkBoardOriginSessionId } from "../shared/work-board-types.js";
import { JudgeContractError } from "./judge/judge-contract.js";

/** Resolve only host-recorded spawn ownership; call input never supplies ancestry. */
export function createRootSessionResolver(
  originSessionIdFor: (sessionId: string) => string | undefined,
): (sessionId: string) => string {
  return (sessionId) => {
    const visited = new Set<string>();
    let current = sessionId;
    while (true) {
      if (visited.has(current)) {
        throw new JudgeContractError("Session ancestry contains a cycle");
      }
      visited.add(current);
      const origin = originSessionIdFor(current);
      if (origin === undefined) return current;
      if (parseWorkBoardOriginSessionId(origin) !== null) return origin;
      if (!isValidSessionId(origin)) {
        throw new JudgeContractError("Session ancestry contains an invalid origin");
      }
      current = origin;
    }
  };
}
