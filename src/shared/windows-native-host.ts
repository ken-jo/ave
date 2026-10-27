import { getBuiltinModule } from "node:process";

const NATIVE_HOST_TYPE = getBuiltinModule("node:os").type();

/** Native helper discovery and handle access require the host kernel. */
export function assertWindowsNativeHost(): void {
  if (NATIVE_HOST_TYPE !== "Windows_NT") throw new Error("Native Windows access requires a Windows host");
}

export function runWindowsNative<T>(operation: () => T): T {
  assertWindowsNativeHost();
  return operation();
}
