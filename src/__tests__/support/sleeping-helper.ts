// A stand-in for a native helper that starts but never answers: it sleeps far past any test bound, so only the caller's deadline
// ends it. Resolved at import, before a suite stubs the platform or environment.
import { join } from "node:path";

const SLEEPER = process.platform === "win32"
  ? { file: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE"), args: ["-n", "60", "127.0.0.1"] }
  : { file: "/bin/sleep", args: ["60"] };

export function sleepingHelper(): { file: string; args: string[] } {
  return { file: SLEEPER.file, args: [...SLEEPER.args] };
}
