import { resolve } from "node:path";
import { beforeAll } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";

/** Windows host shell launches hold their directory through the source-tree native helper. */
export function withSourceHostResources(): void {
  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
}
