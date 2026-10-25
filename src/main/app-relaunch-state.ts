let appRelaunchRequested = false;

export function isAppRelaunchRequested(): boolean {
  return appRelaunchRequested;
}

export function setAppRelaunchRequested(requested: boolean): void {
  appRelaunchRequested = requested;
}
