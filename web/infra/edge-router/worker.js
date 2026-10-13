/**
 * Edge router for former-site.invalid — proxies the apex (and redirects www) to the
 * Cloudflare Pages project without requiring a DNS record change.
 *
 * Why a Worker: the zone's apex A/AAAA records still point at the retired
 * GitHub Pages origin, and the available OAuth scopes cannot edit DNS. The
 * zone is proxied, so a route-bound Worker intercepts at the edge before the
 * origin is ever contacted. If the DNS records are later switched to a CNAME
 * on former-site.invalid, this Worker becomes redundant and can be deleted.
 */
const ORIGIN = "former-site.invalid";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "www.former-site.invalid") {
      url.hostname = "former-site.invalid";
      return Response.redirect(url.toString(), 301);
    }
    url.hostname = ORIGIN;
    return fetch(new Request(url, request));
  },
};
