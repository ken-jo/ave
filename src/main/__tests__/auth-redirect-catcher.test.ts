// Real sockets exercise interface binding, forged requests, and port ownership.
import { describe, expect, it, afterEach, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { Server } from "node:net";
import { AuthRedirectCatchers } from "../auth-redirect-catcher.js";

const OWNER = "samplemail";
const OTHER_OWNER = "meeting";

const openCatchers: Array<{ catchers: AuthRedirectCatchers; owner: string; handle: string }> = [];

afterEach(() => {
  while (openCatchers.length > 0) {
    const entry = openCatchers.pop();
    if (entry !== undefined) entry.catchers.close(entry.owner, entry.handle);
  }
});

async function open(
  catchers: AuthRedirectCatchers,
  owner = OWNER,
): Promise<{ handle: string; redirectUri: string }> {
  const result = await catchers.open(owner, { state: "xyz" });
  openCatchers.push({ catchers, owner, handle: result.handle });
  return result;
}

// One request to the catcher, with full control over the line the server sees.
function hit(
  redirectUri: string,
  path: string,
  options: { method?: string; hostHeader?: string } = {},
): Promise<{ status: number; location: string | undefined; body: string }> {
  const { port } = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(port),
        path,
        method: options.method ?? "GET",
        headers:
          options.hostHeader === undefined ? {} : { host: options.hostHeader },
        // The catcher answers the redirect with a 303 to itself; following it here would collapse the two responses this suite wants to tell apart.
        setHost: options.hostHeader === undefined,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the listener it binds", () => {
  it("retries a blocked first port before publishing the redirect URI", async () => {
    const address = vi.spyOn(Server.prototype, "address")
      .mockReturnValueOnce({ address: "127.0.0.1", family: "IPv4", port: 6000 });
    const close = vi.spyOn(Server.prototype, "close");
    try {
      const catchers = new AuthRedirectCatchers();
      const { redirectUri } = await open(catchers);
      expect(Number(new URL(redirectUri).port)).not.toBe(6000);
      expect(close).toHaveBeenCalled();
      await expect(hit(redirectUri, "/")).resolves.toMatchObject({ status: 200 });
    } finally {
      address.mockRestore();
      close.mockRestore();
    }
  });

  it("binds loopback and reports the URI by HOST NAME, not by address", async () => {
    const catchers = new AuthRedirectCatchers();
    const { redirectUri } = await open(catchers);
    // `localhost`, not `127.0.0.1`. Identity providers register loopback redirect URIs by host and allow any port; the other spelling is a DIFFERENT
    // redirect URI and the provider rejects it. This is the one detail that decides whether a real sign-in works at all.
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+$/u);
    expect(Number(new URL(redirectUri).port)).toBeGreaterThan(0);
  });

  it("can name the listener by the RFC 8252 loopback IP literal and still catch the redirect there", async () => {
    const catchers = new AuthRedirectCatchers();
    const result = await catchers.open(OWNER, { state: "xyz", redirectHost: "127.0.0.1" });
    openCatchers.push({ catchers, owner: OWNER, handle: result.handle });
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const waiting = catchers.wait(OWNER, result.handle);
    const response = await hit(result.redirectUri, "/?code=abc123&state=xyz");
    expect(response.location).toBe(result.redirectUri);
    await expect(waiting).resolves.toEqual({ code: "abc123", state: "xyz" });
  });

  it("refuses a second open for the same plugin rather than replacing the first", async () => {
    const catchers = new AuthRedirectCatchers();
    const first = await open(catchers);
    await expect(catchers.open(OWNER, { state: "xyz" })).rejects.toThrow(/already open/u);
    // The first is still live: replacing it would have stranded a sign-in already in flight, whose redirect would then arrive at a closed port AFTER the
    // user had typed their password.
    await expect(hit(first.redirectUri, "/")).resolves.toMatchObject({ status: 404 });
  });

  it("lets a different plugin open its own, on its own port", async () => {
    const catchers = new AuthRedirectCatchers();
    const mine = await open(catchers, OWNER);
    const theirs = await open(catchers, OTHER_OWNER);
    expect(theirs.redirectUri).not.toBe(mine.redirectUri);
  });
});

describe("what it accepts", () => {
  it("round-trips a prototype-named parameter as an own frozen data property", async () => {
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    expect((await hit(redirectUri, "/?state=xyz&__proto__=x")).status).toBe(303);
    const params = await catchers.wait(OWNER, handle);
    expect(Object.hasOwn(params, "__proto__")).toBe(true);
    expect(params["__proto__"]).toBe("x");
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(Object.isFrozen(params)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(params, "__proto__")).toEqual({ value: "x", writable: false, enumerable: true, configurable: false });
  });

  it("resolves the wait with the redirect's query parameters", async () => {
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    const waiting = catchers.wait(OWNER, handle);
    await hit(redirectUri, "/?code=abc123&state=xyz");
    await expect(waiting).resolves.toEqual({ code: "abc123", state: "xyz" });
  });

  it("resolves a wait that arrives AFTER the redirect did", async () => {
    // The browser can land before the caller gets around to waiting. A wait that only ever watched for a future arrival would hang on exactly the fast path,
    // and the hang would look like a user who never signed in.
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    await hit(redirectUri, "/?code=early&state=xyz");
    await expect(catchers.wait(OWNER, handle)).resolves.toEqual({ code: "early", state: "xyz" });
  });

  it("sends the browser away from the URL that carries the code", async () => {
    // A 303 back to the bare URI, so the authorization code does not sit in the user's history. The page they end up looking at is the landing page.
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    const waiting = catchers.wait(OWNER, handle);
    const response = await hit(redirectUri, "/?code=abc123&state=xyz");
    expect(response.status).toBe(303);
    expect(response.location).toBe(redirectUri);
    expect(response.body).not.toContain("abc123");
    await waiting;
  });

  it("serves the host's own page, never markup the caller supplied", async () => {
    const catchers = new AuthRedirectCatchers();
    const { redirectUri } = await open(catchers);
    await hit(redirectUri, "/?code=abc123&state=xyz");
    const landing = await hit(redirectUri, "/");
    expect(landing.status).toBe(200);
    expect(landing.body).toContain("Sign-in complete");
    // There is no parameter through which a caller could reach this body. The absence is the point: a caller-supplied template would be plugin markup
    // rendered by the user's browser on a loopback origin.
  });

  it("tells the user the sign-in FAILED when the provider refused", async () => {
    // The refusal arrives at the same URI as the success — `?error=` instead of `?code=`. A landing page that said "complete" for that would be telling the
    // user something the app is about to contradict.
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    const waiting = catchers.wait(OWNER, handle);
    await hit(redirectUri, "/?error=access_denied&error_description=User+cancelled&state=xyz");
    await expect(waiting).resolves.toMatchObject({ error: "access_denied" });
    const landing = await hit(redirectUri, "/");
    expect(landing.body).toContain("Sign-in failed");
    expect(landing.body).not.toContain("Sign-in complete");
  });
});

describe("what it refuses", () => {
  it.each(["__proto__", "constructor"])("refuses duplicate %s parameters without consuming the callback", async name => {
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    let completed = false;
    const waiting = catchers.wait(OWNER, handle);
    void waiting.then(() => { completed = true; }, () => undefined);
    expect((await hit(redirectUri, `/?state=xyz&${name}=x&${name}=y`)).status).toBe(404);
    expect(completed).toBe(false);
    expect((await hit(redirectUri, "/?code=real&state=xyz")).status).toBe(303);
    await expect(waiting).resolves.toEqual({ code: "real", state: "xyz" });
  });

  it("keeps waiting after unrelated paths and wrong states, then consumes only one matching callback", async () => {
    const catchers = new AuthRedirectCatchers();
    const result = await catchers.open(OWNER, { state: "expected-state" });
    openCatchers.push({ catchers, owner: OWNER, handle: result.handle });
    let completed = false;
    const waiting = catchers.wait(OWNER, result.handle);
    void waiting.then(() => { completed = true; }, () => undefined);
    for (const path of ["/unrelated?x=1", "/unrelated?code=forged&state=expected-state", "/?code=forged&state=wrong", "/?code=forged", "/?state=wrong&state=expected-state&code=forged"]) {
      expect((await hit(result.redirectUri, path)).status, path).toBe(404);
      expect(completed).toBe(false);
    }
    expect((await hit(result.redirectUri, "/?code=real&state=expected-state")).status).toBe(303);
    await expect(waiting).resolves.toEqual({ code: "real", state: "expected-state" });
    expect((await hit(result.redirectUri, "/?code=replay&state=expected-state")).status).toBe(404);
    await expect(catchers.wait(OWNER, result.handle)).resolves.toEqual({ code: "real", state: "expected-state" });
  });

  it("holds a catcher opened without a state (the plugin contract) to its exact callback path", async () => {
    const catchers = new AuthRedirectCatchers();
    const result = await catchers.open(OWNER);
    openCatchers.push({ catchers, owner: OWNER, handle: result.handle });
    let completed = false;
    const waiting = catchers.wait(OWNER, result.handle);
    void waiting.then(() => { completed = true; }, () => undefined);
    expect((await hit(result.redirectUri, "/unrelated?x=1")).status).toBe(404);
    expect(completed).toBe(false);
    expect((await hit(result.redirectUri, "/?code=plugin&state=any")).status).toBe(303);
    await expect(waiting).resolves.toEqual({ code: "plugin", state: "any" });
  });

  it("authenticates an error callback with the reserved state", async () => {
    const catchers = new AuthRedirectCatchers();
    const result = await catchers.open(OWNER, { state: "expected-error" });
    openCatchers.push({ catchers, owner: OWNER, handle: result.handle });
    expect((await hit(result.redirectUri, "/?error=access_denied&state=wrong")).status).toBe(404);
    expect((await hit(result.redirectUri, "/?error=access_denied&state=expected-error")).status).toBe(303);
    await expect(catchers.wait(OWNER, result.handle)).resolves.toEqual({ error: "access_denied", state: "expected-error" });
    expect((await hit(result.redirectUri, "/")).body).toContain("Sign-in failed");
  });

  it("refuses a non-GET request", async () => {
    const catchers = new AuthRedirectCatchers();
    const { redirectUri } = await open(catchers);
    await expect(hit(redirectUri, "/?code=x", { method: "POST" })).resolves.toMatchObject({
      status: 405,
    });
  });

  it("refuses a request whose Host header is not loopback", async () => {
    // Loopback binding cannot prevent browser or DNS-rebinding requests; the downstream state check must reject forged codes.
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    let settled = false;
    void catchers.wait(OWNER, handle).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const response = await hit(redirectUri, "/?code=forged", {
      hostHeader: "attacker.example.com",
    });
    expect(response.status).toBe(400);
    // And it did not resolve the wait, which is the part that would have mattered: a 400 that still handed the code to the plugin would be worse than no check at all.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  });

  it("reports another plugin's handle as unknown rather than as forbidden", async () => {
    // Telling the two apart would let a plugin probe for another plugin's live sign-in — a side channel opened by an error message.
    const catchers = new AuthRedirectCatchers();
    const { handle } = await open(catchers, OWNER);
    await expect(catchers.wait(OTHER_OWNER, handle)).rejects.toThrow(
      /unknown redirect-catcher handle/u,
    );
    await expect(
      catchers.wait(OTHER_OWNER, "8f1c2e5a-0000-4000-8000-aaaaaaaaaaaa"),
    ).rejects.toThrow(/unknown redirect-catcher handle/u);
  });

  it("refuses a timeout outside its bounds instead of clamping it", async () => {
    const catchers = new AuthRedirectCatchers();
    const { handle } = await open(catchers);
    await expect(catchers.wait(OWNER, handle, 1)).rejects.toThrow(/timeoutMs must be between/u);
    await expect(catchers.wait(OWNER, handle, Number.NaN)).rejects.toThrow(/finite/u);
  });

  it("closes the listener when the wait times out", async () => {
    // A port left bound after the caller stopped waiting is a listener nobody owns, and the owner slot it holds would refuse the user's next attempt.
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    // Only the wait's own timer is faked; the listener stays on real sockets.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let timedOut: Promise<void> | undefined;
    try {
      let settled = false;
      const waiting = catchers.wait(OWNER, handle, 5_000 /* min */);
      timedOut = expect(waiting).rejects.toThrow(/no redirect received/u);
      void waiting.catch(() => undefined).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
    await timedOut;
    await expect(hit(redirectUri, "/")).rejects.toThrow();
    // ...and the slot is free again.
    await expect(open(catchers)).resolves.toBeDefined();
  });
});

describe("closing", () => {
  it("rejects a pending wait and frees the owner slot", async () => {
    const catchers = new AuthRedirectCatchers();
    const { handle } = await open(catchers);
    const waiting = catchers.wait(OWNER, handle);
    catchers.close(OWNER, handle);
    await expect(waiting).rejects.toThrow(/was closed/u);
    await expect(open(catchers)).resolves.toBeDefined();
  });

  it("ignores a close from a plugin that does not own the handle", async () => {
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers, OWNER);
    catchers.close(OTHER_OWNER, handle);
    await expect(hit(redirectUri, "/")).resolves.toMatchObject({ status: 404 });
  });

  it("is idempotent, including for a handle that never existed", () => {
    const catchers = new AuthRedirectCatchers();
    expect(() => catchers.close(OWNER, "no-such-handle")).not.toThrow();
  });
});
