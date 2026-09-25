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
