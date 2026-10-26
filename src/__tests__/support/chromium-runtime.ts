import { afterAll, beforeAll } from "vitest";

// The node test project has no Chromium; files that build the browser user agent declare the Electron runtime's version and restore it afterwards.
export function useChromiumRuntime(version = "156.0.7000.0"): void {
  const versions = process.versions as Record<string, string | undefined>;
  let previous: string | undefined;
  beforeAll(() => {
    previous = versions.chrome;
    versions.chrome = version;
  });
  afterAll(() => {
    if (previous === undefined) delete versions.chrome;
    else versions.chrome = previous;
  });
}
