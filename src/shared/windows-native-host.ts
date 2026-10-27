import { getBuiltinModule } from "node:process";

const nativeOs = getBuiltinModule("node:os");

/** Native helper discovery and handle access require the host kernel. */
export function assertWindowsNativeHost(): void {
  if (nativeOs.platform() !== "win32") throw new Error("Native Windows access requires a Windows host");
}
