import { redactHomePathsInText } from "../../audit/dlp-filter.js";
import { maskSensitiveData, scrubDiagnosticSecretsStrict } from "../../shared/dlp.js";

const SUMMARY_LIMIT = 2048;

export function redactRecentlyDeniedText(value: string, limit = SUMMARY_LIMIT): string {
  return redactHomePathsInText(maskSensitiveData(scrubDiagnosticSecretsStrict(value), { pii: true }).masked).slice(0, limit);
}
