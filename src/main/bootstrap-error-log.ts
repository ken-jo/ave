import pino from "pino";
import { scrubDiagnosticSecretsStrict } from "../shared/dlp.js";

interface BootstrapErrorLogRecord {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

// Serialize first so nested causes cannot be appended after redaction. Project
// only diagnostic fields; the serializer's raw error and arbitrary properties stay internal.
export function bootstrapErrorForLog(error: unknown): BootstrapErrorLogRecord {
  let fields: BootstrapErrorLogRecord;
  try {
    const failure = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown bootstrap failure");
    const serialized = pino.stdSerializers.err(failure);
    const code = "code" in failure ? failure.code : undefined;
    fields = {
      name: scrubDiagnosticSecretsStrict(serialized.type),
      message: scrubDiagnosticSecretsStrict(serialized.message),
      ...(typeof serialized.stack === "string" ? { stack: scrubDiagnosticSecretsStrict(serialized.stack) } : {}),
      ...(typeof code === "string" ? { code: scrubDiagnosticSecretsStrict(code) } : {}),
    };
  } catch {
    // Diagnostic failures must never fall back to the original secret-bearing value.
    fields = { name: "Error", message: "[REDACTED:DIAGNOSTIC]", stack: "[REDACTED:DIAGNOSTIC]" };
  }
  // A later error serializer reads this safe name rather than an Object constructor.
  return Object.assign(Object.create(null) as BootstrapErrorLogRecord, fields);
}
