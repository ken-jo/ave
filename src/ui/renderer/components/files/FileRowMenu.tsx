/** The menu of one file row, opened at a point (a right-click, or the row itself for the keyboard). It is drawn in the page,
 * so choosing an item is a click or key press the page itself receives. */
import { createPortal } from "react-dom";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../../components/ui/dropdown-menu.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { FileRowAction } from "./file-row-actions.js";

export interface FileRowMenuState {
  /** Where the menu opens, in viewport coordinates. */
  x: number;
  y: number;
  /** The row's name, read out as the menu's name. */
  name: string;
  actions: readonly FileRowAction[];
}

export function FileRowMenu({ menu, onClose, focusTarget }: {
  menu: FileRowMenuState;
  /** The menu closed: an item was chosen, Escape, or a click elsewhere. */
  onClose: () => void;
  /** The row the menu was for. Focus returns to it when the menu closes, unless the chosen action moved focus itself. */
  focusTarget: () => HTMLElement | null | undefined;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* The anchor is a point of the window. It is placed under the body, because inside a panel that is transformed or
          contained "fixed" would be measured from that panel and the menu would open away from the pointer. */}
      {createPortal(
        <DropdownMenuTrigger asChild>
          <span style={{ position: "fixed", left: menu.x, top: menu.y, width: 0, height: 0 }} />
        </DropdownMenuTrigger>,
        document.body,
      )}
      <DropdownMenuContent align="start" sideOffset={0} aria-label={menu.name} data-testid="file-row-menu"
        onCloseAutoFocus={(event) => {
          // The menu's own anchor cannot take focus; the row does, when focus is still where the menu left it.
          event.preventDefault();
          const active = document.activeElement;
          if (active === null || active === document.body || active.closest("[role='menu']") !== null) focusTarget()?.focus();
        }}>
        {menu.actions.map((action) => (
          <DropdownMenuItem key={action.id} onSelect={action.run} data-testid={`file-row-action-${action.id}`} className="gap-2">
            <action.icon aria-hidden="true" className="h-3.5 w-3.5" />{t(action.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
