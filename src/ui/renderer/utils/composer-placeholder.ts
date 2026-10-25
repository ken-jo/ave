import { t } from "../../../i18n/runtime.js";
import { isDarwin } from "../api-client.js";
import type { SuggestedRepliesSnapshot } from "../hooks/use-suggested-replies.js";

export function hasActiveSuggestedReplies(suggestedReplies: SuggestedRepliesSnapshot): boolean {
  return !suggestedReplies.isDismissed && suggestedReplies.text !== null;
}

export function computeComposerPlaceholder(opts: {
  hasApiKey: boolean | null | undefined;
  streaming: boolean;
  /** Absent on a surface that has no suggested-replies feed (the side chat). */
  suggestedReplies?: SuggestedRepliesSnapshot;
  subscriptionPending?: boolean;
  subscriptionUnavailable?: boolean;
}): string {
  if (opts.subscriptionPending) return t("subscriptionProvidersSection.statusChecking");
  if (opts.subscriptionUnavailable) return t("formatIpcError.subscriptionChatUnavailable");
  if (opts.hasApiKey === false) return t("composerPlaceholder.apiKeyMissing");
  if (opts.suggestedReplies && hasActiveSuggestedReplies(opts.suggestedReplies)) {
    return "";
  }
  if (opts.streaming) return t("composerPlaceholder.streamingHint");
  // Choose the paste modifier by platform, not locale; substitute it into one translatable sentence.
  return t("composerPlaceholder.defaultHint", {
    pasteModifier: isDarwin() ? "⌘" : "Ctrl",
  });
}
