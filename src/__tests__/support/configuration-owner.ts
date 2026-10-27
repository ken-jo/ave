import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { setAveHomeConfigurationOwner } from "../../shared/ave-home-configuration-access.js";

export function useConfigurationOwner(): void {
  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
  beforeEach(() => setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true }));
  afterEach(() => setAveHomeConfigurationOwner(undefined));
}
