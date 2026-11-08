import { createContext, forwardRef, useContext, type ComponentPropsWithoutRef } from "react";
import { Button } from "../../../components/ui/button.js";
import { DropdownMenuItem } from "../../../components/ui/dropdown-menu.js";

export const ToolbarStatusMenuContext = createContext(false);

/** Popup triggers keep the menu mounted while their own surface is open. */
export const ToolbarStatusMenuButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & { menuLabel?: string }
>(function ToolbarStatusMenuButton({ menuLabel, ...props }, ref) {
  const inMenu = useContext(ToolbarStatusMenuContext);
  if (!inMenu) return <Button ref={ref} {...props} />;
  return (
    <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
      <Button {...props} ref={ref} className="h-auto w-full justify-start gap-2 whitespace-normal px-2 py-1.5 text-left text-body-sm">
        {props.children}
        {menuLabel ? <span>{menuLabel}</span> : null}
      </Button>
    </DropdownMenuItem>
  );
});
