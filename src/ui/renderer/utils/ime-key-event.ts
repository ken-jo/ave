import type React from "react";

/** Composition commit keydowns may have isComposing:false with keyCode:229; treat either as IME input so Enter cannot
 * double-send. */
export function isComposingKeyEvent(e: React.KeyboardEvent<HTMLElement>): boolean {
  const reactEvent = e as React.KeyboardEvent<HTMLElement> & {
    isComposing?: boolean;
  };
  const nativeEvent = e.nativeEvent as KeyboardEvent & {
    isComposing?: boolean;
    keyCode?: number;
  };
  return Boolean(
    reactEvent.isComposing ||
      nativeEvent.isComposing ||
      nativeEvent.keyCode === 229 ||
      e.key === "Process",
  );
}
