/** Validate parsed protocols and credentials through the shared authority at every navigation boundary; substring checks
 * are insufficient. */
import { validateExternalUrl } from "../../../shared/external-url.js";

export function normalizeBrowserNavigationUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const validated = validateExternalUrl(candidate);
  return validated.ok ? validated.url : null;
}
