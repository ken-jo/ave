import { getBuiltinModule } from "node:process";

const NATIVE_HOST_TYPE = getBuiltinModule("node:os").type();
const nativeReplyDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Reject corrupt native replies before interpreting any path or status. */
export function decodeWindowsNativeReply(reply: Uint8Array): string {
  return nativeReplyDecoder.decode(reply);
}

/** Native helper discovery and handle access require the host kernel. */
export function assertWindowsNativeHost(): void {
  if (NATIVE_HOST_TYPE !== "Windows_NT") throw new Error("Native Windows access requires a Windows host");
}

export function runWindowsNative<T>(operation: () => T): T {
  assertWindowsNativeHost();
  return operation();
}
