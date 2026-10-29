/** The pane frame owns the page edge; extra wrapper margins would inset the settings divider and measure responsiveness
 * against the window. */
import { SettingsContent } from "./SettingsContent.js";
import type { AveApi } from "./types.js";
import type { ExactDenyDraft } from "./exact-permission-decision.js";

export function SettingsInlineView({
  api,
  initialTab,
  sectionTarget = null,
  onSectionApplied,
  onSaved,
  onTabChange,
  exactDenyDraft = null,
  onExactDenySaved,
  onDiscardExactDeny,
}: {
  api: AveApi;
  initialTab: string;
  /** The section inside `initialTab` a deep link named, or `null`. One-shot: the panel reports back through
   * `onSectionApplied` and the window drops it. */
  sectionTarget?: string | null;
  onSectionApplied?: () => void;
  onSaved: () => void;
  /** Required here (unlike on `SettingsContent`): the inline panel is the app's
   *  own settings surface, so dropping the read-back would leave the app unable
   *  to say where the user is. A missing forward is a type error, not a silent
   *  regression. */
  onTabChange: (tab: string) => void;
  exactDenyDraft?: ExactDenyDraft | null;
  onExactDenySaved?: (requestId: string) => void;
  onDiscardExactDeny?: () => void;
}) {
  return (
    <SettingsContent
      api={api}

      onSaved={onSaved}
      initialTab={initialTab}
      sectionTarget={sectionTarget}
      onSectionApplied={onSectionApplied}
      onTabChange={onTabChange}
      exactDenyDraft={exactDenyDraft}
      onExactDenySaved={onExactDenySaved}
      onDiscardExactDeny={onDiscardExactDeny}
    />
  );
}
