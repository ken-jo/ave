import { dirname } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { _resetAveHomePrivacyForTest, ensureAveHomePrivate } from "../../shared/ave-home.js";
import { migrateAveHomeConfiguration } from "../../shared/ave-home-configuration.js";
import { useConfigurationOwner as configureTestOwner } from "./configuration-owner.js";
import { setFixtureOwner } from "./fixture-owner.js";
import { useTempPaths as tempPaths } from "../test-helpers.js";

/** A fresh Ave home per test whose configuration boundary is committed, so the default stores accept the owner's writes. */
export function setupCommittedAveHome(prefix: string): void {
  configureTestOwner();
  const homes = tempPaths(prefix, ".ave");
  beforeEach(() => {
    const home = homes();
    setFixtureOwner(dirname(home));
    vi.stubEnv("AVE_HOME", home);
    migrateAveHomeConfiguration(home, ensureAveHomePrivate(home));
  });
  afterEach(() => {
    _resetAveHomePrivacyForTest();
    vi.unstubAllEnvs();
  });
}
