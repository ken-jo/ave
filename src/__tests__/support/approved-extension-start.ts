import {
  requestExtensionStartConsent, setExtensionStartAsker, type ExtensionStartAsker, type ExtensionStartAuthority, type PendingExtensionStart,
} from "../../permissions/extension-start-consent.js";

/** The identity fixtures give a start that has nothing real to hash. */
export const FIXTURE_START_IDENTITY = "fixture-identity";

/** A card answered start by start: each start on it gets what `answer` says; "no-approver" leaves that start unanswered. */
export function answerEachStart(answer: (start: PendingExtensionStart) => "yes" | "no" | "no-approver"): ExtensionStartAsker["ask"] {
  return async (starts) => {
    const answers = new Map<string, "yes" | "no">();
    for (const start of starts) {
      const given = answer(start);
      if (given !== "no-approver") answers.set(start.key, given);
    }
    return answers;
  };
}

/** The consent a person's yes gives one extension start that nothing confines. */
export async function approvedExtensionStart(key: string, identity: string = FIXTURE_START_IDENTITY): Promise<ExtensionStartAuthority | undefined> {
  setExtensionStartAsker({ ask: answerEachStart(() => "yes"), notify: () => {} });
  try {
    return await requestExtensionStartConsent({ key, identity, kind: "plugin-child", label: key, cause: "no-backend" }, { sessionId: "fixture", attended: true });
  } finally {
    setExtensionStartAsker(undefined);
  }
}
