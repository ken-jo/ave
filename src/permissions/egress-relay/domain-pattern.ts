// Portions derived from @anthropic-ai/sandbox-runtime (Apache-2.0) and modified; see THIRD-PARTY-NOTICES.
// Destination patterns: `host`, `*.suffix`, `*`, each with an optional `:port`.
import { isIP } from "node:net";
import { canonicalRelayHost, stripBrackets } from "./destination.js";

function withoutZone(host: string): string {
  const at = host.indexOf("%");
  return at < 0 ? host : host.slice(0, at);
}

function portOf(text: string): number | undefined {
  if (!/^[1-9][0-9]{0,4}$/.test(text)) return undefined;
  const port = Number(text);
  return port <= 65535 ? port : undefined;
}

// A bracketed or bare IPv6 pattern is compared in canonical spelling; a suffix that is not a port stays part of the host pattern.
function splitPort(pattern: string): { host: string; port: number | undefined } {
  const whole = { host: pattern, port: undefined };
  if (pattern.startsWith("[")) {
    const close = pattern.indexOf("]");
    if (close < 0) return whole;
    const inner = withoutZone(pattern.slice(1, close));
    const host = canonicalRelayHost(inner) ?? inner;
    const rest = pattern.slice(close + 1);
    if (rest === "") return { host, port: undefined };
    const port = portOf(rest.startsWith(":") ? rest.slice(1) : "");
    return port === undefined ? whole : { host, port };
  }
  const last = pattern.lastIndexOf(":");
  if (last < 0) return whole;
  if (pattern.indexOf(":") !== last) {
    const host = withoutZone(pattern);
    return { host: canonicalRelayHost(host) ?? host, port: undefined };
  }
  const port = portOf(pattern.slice(last + 1));
  return port === undefined ? whole : { host: pattern.slice(0, last), port };
}

// Case-insensitive. A wildcard admits strict subdomains only and never an address literal.
function matchesHostPattern(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const host = hostname.toLowerCase();
  if (!pattern.startsWith("*.")) return host === pattern.toLowerCase();
  return isIP(stripBrackets(host)) === 0 && host.endsWith(`.${pattern.slice(2).toLowerCase()}`);
}

// A pattern without a port admits every port.
export function matchesDomainPatternWithPort(hostname: string, port: number, pattern: string): boolean {
  const split = splitPort(pattern);
  if (split.port !== undefined && split.port !== port) return false;
  return matchesHostPattern(hostname, split.host);
}
