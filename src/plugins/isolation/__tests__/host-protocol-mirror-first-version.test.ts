/**
 * `HOST_PROTOCOL_FIRST_APP_VERSION` is read off the release history
 * (`docs/design/plugin-hostapi-protocol.md` decision 29): for each protocol
 * this build serves, it is the lowest app version the published schema mirror
 * records for that protocol. A literal that drifted from the mirror would let
 * the validator pass a `minAppVersion` an older app cannot load, or refuse one
 * it can.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareSemver } from "../../../shared/semver-compare.js";
import {
  HOST_PROTOCOL_FIRST_APP_VERSION,
  HOST_PROTOCOL_VERSIONS_SERVED,
} from "../host-api-wire.js";

const MIRROR = fileURLToPath(
  new URL("../../../../web/public/schemas/plugin-host-protocol/mirror.json", import.meta.url),
);

interface MirrorCopy {
  readonly protocol: string;
  readonly appVersion: string;
}

describe("HOST_PROTOCOL_FIRST_APP_VERSION", () => {
  const copies = (JSON.parse(readFileSync(MIRROR, "utf-8")) as { copies: MirrorCopy[] }).copies;

  it("names exactly the protocols this build serves", () => {
    expect(Object.keys(HOST_PROTOCOL_FIRST_APP_VERSION).sort()).toEqual([...HOST_PROTOCOL_VERSIONS_SERVED].sort());
  });

  for (const protocol of HOST_PROTOCOL_VERSIONS_SERVED) {
    it(`is the lowest appVersion the mirror records for protocol ${protocol}`, () => {
      const recorded = copies
        .filter((copy) => copy.protocol === protocol)
        .map((copy) => copy.appVersion)
        .sort(compareSemver);
      expect(recorded.length).toBeGreaterThan(0);
      expect(HOST_PROTOCOL_FIRST_APP_VERSION[protocol]).toBe(recorded[0]);
    });
  }
});
