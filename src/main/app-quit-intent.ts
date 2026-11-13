let appQuitRequested = false;

export function isAppQuitRequested(): boolean {
  return appQuitRequested;
}

export function setAppQuitRequested(value: boolean): void {
  appQuitRequested = value;
}
