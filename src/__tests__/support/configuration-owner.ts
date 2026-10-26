import { afterEach, beforeEach } from "vitest";
import { setAveHomeConfigurationOwner } from "../../shared/ave-home-configuration-access.js";

export function useConfigurationOwner(): void {
  beforeEach(() => setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true }));
  afterEach(() => setAveHomeConfigurationOwner(undefined));
}
