let appRelaunchRequested = false;
const relaunchListeners = new Set<(requested: boolean) => void>();

export function isAppRelaunchRequested(): boolean {
  return appRelaunchRequested;
}

export function setAppRelaunchRequested(requested: boolean): void {
  appRelaunchRequested = requested;
  for (const listener of relaunchListeners) listener(requested);
}

export function onAppRelaunchChanged(listener: (requested: boolean) => void): () => void {
  relaunchListeners.add(listener);
  listener(appRelaunchRequested);
  return () => { relaunchListeners.delete(listener); };
}
