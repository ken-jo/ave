import {
  requestExtensionStartConsent, setExtensionStartAsker, type ExtensionStartAuthority,
} from "../../permissions/extension-start-consent.js";

/** The consent a person's yes gives one extension start that nothing confines. */
export async function approvedExtensionStart(key: string): Promise<ExtensionStartAuthority | undefined> {
  setExtensionStartAsker({ ask: async () => "yes", notify: () => {} });
  try {
    return await requestExtensionStartConsent({ key, kind: "plugin-child", label: key, cause: "no-backend" }, { sessionId: "fixture", attended: true });
  } finally {
    setExtensionStartAsker(undefined);
  }
}
