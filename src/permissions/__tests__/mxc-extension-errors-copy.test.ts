// The Windows start gate can still throw the worker-transport refusal, so its wording stays main's in both locales:
// it names the Windows extension container it is about.
import { afterEach, describe, expect, it } from "vitest";
import { getLocale, setLocale } from "../../i18n/runtime.js";
import { WorkerTransportUnsupportedError } from "../mxc-extension-errors.js";

const previous = getLocale();
afterEach(() => { setLocale(previous); });

describe("the worker-transport refusal", () => {
  it.each(["en", "ko"] as const)("names Windows in %s", (locale) => {
    setLocale(locale);
    const error = new WorkerTransportUnsupportedError();
    expect(error.message).toContain("Windows");
    expect(error.message).toContain("worker-transport-unsupported");
  });
});
