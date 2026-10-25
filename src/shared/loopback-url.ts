/** Local HTTP exceptions accept literal loopback or localhost, never subdomains that may resolve remotely. URL checks do not replace resolved-IP or bind-host checks. */

/** Only HTTP needs this exemption; HTTPS is admitted on its own terms. */
export function isLoopbackHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  return isLoopbackUrlHostname(parsed.hostname);
}

/** Accept parser-produced canonical hostnames, including brackets and a trailing root dot. */
export function isLoopbackUrlHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost") return true;
  if (host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
