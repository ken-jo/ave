import { writeSync } from "node:fs";

/** A process 'exit' handler runs after shutdown has closed the file log sink and cannot wait for the async logger, so its one-line diagnostic goes to
 * stderr with a synchronous write. A GUI process may have no usable stderr at that point; the line is then lost, since nothing is left to report to. */
export function writeExitDiagnostic(message: string): void {
  try {
    writeSync(2, `ave: ${message}\n`);
  } catch {
    // No stderr to report on (a detached GUI process at exit).
  }
}
