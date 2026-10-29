import { deferred } from "../../../__tests__/support/deferred.js";
import { describe, expect, it } from "vitest";
import { hasMarketplaceInstallInFlight, withMarketplaceInstall } from "../install-lifecycle.js";

describe("marketplace install lifecycle", () => {
  it("keeps concurrent installs busy until the last operation settles", async () => {
    const { promise: held, resolve: release } = deferred<void>();
    const pending = withMarketplaceInstall(() => held);
    try {
      await withMarketplaceInstall(async () => undefined);
      expect(hasMarketplaceInstallInFlight()).toBe(true);
    } finally {
      release();
      await pending;
    }
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });

  it("releases admission when an installer throws before returning a promise", async () => {
    await expect(withMarketplaceInstall(() => { throw new Error("install-failed"); })).rejects.toThrow("install-failed");
    expect(hasMarketplaceInstallInFlight()).toBe(false);
    await expect(withMarketplaceInstall(async () => "retried")).resolves.toBe("retried");
  });

  it("releases admission when an asynchronous installer fails", async () => {
    await expect(withMarketplaceInstall(async () => { throw new Error("install-failed"); })).rejects.toThrow("install-failed");
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });
});
