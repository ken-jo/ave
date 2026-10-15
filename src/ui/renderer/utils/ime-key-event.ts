import type React from "react";

/**
 * A keydown that belongs to an IME composition (Korean, Japanese, Chinese
 * input) and must not trigger a shortcut — above all Enter-to-send.
 *
 * `isComposing` alone is not enough in Chromium: the keydown that commits a
 * composition can arrive with `isComposing === false` but `keyCode === 229`
 * (and `key === "Process"`), which is the classic double-submit of the last
 * Hangul syllable.
 */
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
