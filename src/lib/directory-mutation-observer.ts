import { AsyncLocalStorage } from "node:async_hooks";

type DirectoryMutationObserver = (directory: string) => () => void;
const directoryMutationObserver = new AsyncLocalStorage<DirectoryMutationObserver>();

/** Scope immediate child-entry observations to the caller's serialized writes. */
export function withDirectoryMutationObserver<T>(observer: DirectoryMutationObserver, callback: () => T): T {
  return directoryMutationObserver.run(observer, callback);
}

/** Observe immediately around one synchronous filesystem mutation, without yielding. */
export function observeDirectoryMutation<T>(directory: string, mutate: () => T): T {
  const after = directoryMutationObserver.getStore()?.(directory);
  const result = mutate();
  after?.();
  return result;
}
