/** The first app version serving each protocol must match release history or minimum-version admission becomes incorrect. */
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
  readonly publishedTag: string | null;
}

describe("HOST_PROTOCOL_FIRST_APP_VERSION", () => {
  const copies = (JSON.parse(readFileSync(MIRROR, "utf-8")) as { copies: MirrorCopy[] }).copies;

  it("names exactly the protocols this build serves", () => {
    expect(Object.keys(HOST_PROTOCOL_FIRST_APP_VERSION).sort()).toEqual([...HOST_PROTOCOL_VERSIONS_SERVED].sort());
  });

  for (const protocol of HOST_PROTOCOL_VERSIONS_SERVED) {
    it(`distinguishes the release floor from untagged candidates for protocol ${protocol}`, () => {
      const recorded = copies
        .filter((copy) => copy.protocol === protocol)
        .map((copy) => copy.appVersion)
        .sort(compareSemver);
      expect(recorded.length).toBeGreaterThan(0);
      const floor = HOST_PROTOCOL_FIRST_APP_VERSION[protocol];
      if (floor === undefined) {
        expect(copies.filter(copy => copy.protocol === protocol && copy.publishedTag !== null)).toEqual([]);
      } else {
        expect(floor).toBe(recorded[0]);
      }
    });
  }
});
