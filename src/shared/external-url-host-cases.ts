/**
 * Addresses whose verdict must be the same wherever they are parsed. URL parsers disagree on several of them (one
 * percent-encodes a space in the host where another throws), so the rows run under both the Node test runner and the app's
 * renderer document.
 */
export const EXTERNAL_URL_HOST_CASES: readonly { readonly input: string; readonly ok: boolean }[] = [
  { input: "https://example.com/docs", ok: true },
  { input: "https://sub-domain.example.co.kr/", ok: true },
  { input: "https://xn--9n2bp8q.example/", ok: true },
  { input: "http://localhost:3000/", ok: true },
  { input: "http://dev.localhost/", ok: true },
  { input: "http://127.0.0.1:8080/", ok: true },
  { input: "http://[::1]:8080/", ok: true },
  { input: "https://example.com./", ok: true },
  { input: "https://my_service.internal/", ok: true },
  { input: "https://hello world/", ok: false },
  { input: "https://hello%20world/", ok: false },
  { input: "https://exa mple.com/path", ok: false },
  { input: "https://a..b/", ok: false },
  { input: "https://-bad-.example/", ok: false },
  { input: "https://<script>/", ok: false },
  { input: "https://ex^ample.com/", ok: false },
];
