/**
 * One entry of a PAC answer (`PROXY host:port`, `HTTPS host:port`,
 * `SOCKS5 host:port`) as the proxy URL a subprocess understands, or null for
 * `DIRECT` and for kinds a subprocess cannot express.
 *
 * Chromium's resolver answers from the machine's configuration and never
 * returns credentials, which is why subprocess proxies are derived from it
 * rather than inherited from the launching shell's environment.
 */
export function proxyUrlFromPacEntry(entry: string): string | null {
  const [kind, endpoint] = entry.trim().split(/\s+/, 2);
  if (!endpoint) return null;
  switch (kind?.toUpperCase()) {
    case "PROXY": return `http://${endpoint}`;
    case "HTTPS": return `https://${endpoint}`;
    case "SOCKS5": return `socks5://${endpoint}`;
    default: return null;
  }
}

/** One entry of a PAC answer, as the sandbox's upstream routing reads it. */
export type PacEntry =
  | { readonly kind: "direct" }
  | { readonly kind: "proxy"; readonly scheme: "http" | "https"; readonly host: string; readonly port: number }
  | {
    readonly kind: "skipped";
    /** The entry as answered (it carries no credentials: Chromium never puts any in a PAC answer). */
    readonly entry: string;
    /** `socks`: a SOCKS proxy; `unsupported`: another kind (QUIC, unknown); `malformed`: no usable host and port. */
    readonly reason: "socks" | "unsupported" | "malformed";
  };

const PAC_ENDPOINT = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/u;

/**
 * Every entry of a PAC answer in order (`PROXY a:1; HTTPS b:2; DIRECT`), the
 * format `session.resolveProxy` resolves to. An empty answer is DIRECT, as
 * in {@link proxyUrlFromPacEntry}'s callers. `PROXY` is an HTTP proxy and
 * `HTTPS` one reached over TLS; SOCKS kinds, QUIC, unknown kinds and entries
 * without a usable `host:port` are kept as `skipped` so the caller can say
 * why they were passed over.
 */
export function parsePacAnswer(pac: string): PacEntry[] {
  const tokens = pac.split(";").map((token) => token.trim()).filter((token) => token.length > 0);
  if (tokens.length === 0) return [{ kind: "direct" }];
  return tokens.map((entry): PacEntry => {
    const parts = entry.split(/\s+/u);
    const kind = (parts[0] ?? "").toUpperCase();
    if (kind === "DIRECT") return parts.length === 1 ? { kind: "direct" } : { kind: "skipped", entry, reason: "malformed" };
    if (kind === "SOCKS" || kind === "SOCKS4" || kind === "SOCKS5") return { kind: "skipped", entry, reason: "socks" };
    if (kind !== "PROXY" && kind !== "HTTPS") return { kind: "skipped", entry, reason: "unsupported" };
    const match = parts.length === 2 ? PAC_ENDPOINT.exec(parts[1]!) : null;
    const port = match ? Number(match[2]) : NaN;
    if (!match || !Number.isInteger(port) || port < 1 || port > 65535) return { kind: "skipped", entry, reason: "malformed" };
    const host = match[1]!.startsWith("[") ? match[1]!.slice(1, -1) : match[1]!;
    return { kind: "proxy", scheme: kind === "HTTPS" ? "https" : "http", host, port };
  });
}
