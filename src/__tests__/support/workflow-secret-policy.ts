import { parse as parseYaml } from "yaml";

/** Tokenize expression bodies without treating quoted text as context access. */
function* workflowExpressions(value: string, implicit: boolean): Generator<string[]> {
  let start = implicit ? 0 : value.indexOf("${{");
  while (start >= 0) {
    // Keep quoted strings whole, including doubled single quotes. Accept both
    // quote styles and arbitrary whitespace when inspecting member access.
    const lexer = /'(?:''|[^'])*'|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_-]*|\}\}|\S/gu;
    lexer.lastIndex = start + (implicit ? 0 : 3);
    const tokens: string[] = [];
    let end = value.length;
    for (let match = lexer.exec(value); match !== null; match = lexer.exec(value)) {
      if (!implicit && match[0] === "}}") {
        end = lexer.lastIndex;
        break;
      }
      tokens.push(match[0]);
    }
    yield tokens;
    start = implicit ? -1 : value.indexOf("${{", end);
  }
}

/** True when the expression reads the `secrets` context with a key `keyMatches`
 *  accepts, or reads it whole, by wildcard or by a computed key. */
function expressionReadsSecrets(tokens: string[], keyMatches: (key: string) => boolean): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.toLowerCase() !== "secrets" || tokens[index - 1] === ".") continue;
    const access = tokens[index + 1];
    const member = tokens[index + 2] ?? "";
    let key: string;
    if (access === "." && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(member)) {
      key = member;
    } else if (access === "[" && tokens[index + 3] === "]"
      && /^(?:'[\s\S]*'|"[\s\S]*")$/u.test(member)) {
      key = member.slice(1, -1);
    } else {
      // Whole-context, wildcard and computed reads can expose any release key.
      return true;
    }
    if (keyMatches(key)) return true;
  }
  return false;
}

function readsSecrets(value: unknown, keyMatches: (key: string) => boolean, implicit: boolean): boolean {
  if (typeof value === "string") {
    for (const tokens of workflowExpressions(value, implicit)) {
      if (expressionReadsSecrets(tokens, keyMatches)) return true;
    }
    return false;
  }
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some((child) => readsSecrets(child, keyMatches, false));
}

const isReleaseKey = (key: string): boolean => key.toUpperCase().startsWith("R2_");

function readsReleaseSecrets(value: unknown, implicit = false): boolean {
  return readsSecrets(value, isReleaseKey, implicit);
}

/** True when `value` (a string, or every string nested in it) reads the
 *  `secrets` context in any form: a named key, the whole context as in
 *  `toJSON(secrets)`, a wildcard or a computed key. `implicit` reads a bare
 *  string as one expression, the way Actions reads an `if:`. */
export function readsAnySecret(value: unknown, implicit = false): boolean {
  return readsSecrets(value, () => true, implicit);
}

/** Require the literal release environment for secret reads or forwarding. */
export function assertReleaseSecretEnvironments(source: string, name: string): void {
  const { jobs, ...settings } = parseYaml(source, { merge: true }) as {
    jobs: Record<string, {
      environment?: string | { name: string };
      secrets?: unknown;
      if?: unknown;
      steps?: Array<{ if?: unknown }>;
    }>;
  };
  for (const [id, job] of Object.entries(jobs)) {
    // Inheritance includes release keys even when no individual key is named.
    const inherited = typeof job.secrets === "string" && job.secrets.trim().toLowerCase() === "inherit";
    const forwarded = job.secrets !== null && typeof job.secrets === "object"
      && Object.keys(job.secrets).some((key) => key.toUpperCase().startsWith("R2_"));
    // Include workflow-level strings so inherited values need the same boundary.
    if (!inherited && !forwarded && !readsReleaseSecrets([settings, job])
      && !readsReleaseSecrets(job.if, true)
      && !job.steps?.some((step) => readsReleaseSecrets(step.if, true))) continue;
    const environment = typeof job.environment === "string" ? job.environment : job.environment?.name;
    if (environment !== "release") {
      throw new Error(`${name}:${id} reads release secrets without environment: release`);
    }
  }
}
