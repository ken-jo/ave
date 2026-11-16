/** The folder view's text editor: one plain text box over the whole file. Saving and discarding are the header's actions;
 * the platform's save shortcut works while the box has focus. */
import { useEffect, useRef } from "react";
import { useTranslation } from "../../../../i18n/react.js";

export function FileTextEditor({ name, text, busy, onChange, onSave }: {
  name: string;
  text: string;
  busy: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLTextAreaElement | null>(null);
  // Editing starts with the caret in the text, where the person asked to work.
  useEffect(() => { box.current?.focus({ preventScroll: true }); }, []);
  return (
    <textarea
      ref={box}
      data-testid="folder-text-editor"
      aria-label={t("folderView.editTextLabel", { name })}
      value={text}
      readOnly={busy}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      wrap="off"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          onSave();
        }
      }}
      className="min-h-0 w-full flex-1 resize-none overflow-auto bg-background px-4 py-3 font-mono text-xs leading-[1.55] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    />
  );
}
