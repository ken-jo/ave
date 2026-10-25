/** Reinstall repairs damaged artifacts, not policy, provenance, version, or revocation failures. */
import { describe, it, expect } from "vitest";
import {
  PLUGIN_INSTALL_FAILURE_KINDS,
  isPluginInstallFailureKind,
  isReinstallFixableFailureKind,
} from "../plugin-install-failure.js";

describe("isPluginInstallFailureKind", () => {
  it("accepts every declared kind", () => {
    for (const kind of PLUGIN_INSTALL_FAILURE_KINDS) {
      expect(isPluginInstallFailureKind(kind)).toBe(true);
    }
  });

  it("rejects unknown values and non-strings", () => {
    expect(isPluginInstallFailureKind("not-a-kind")).toBe(false);
    expect(isPluginInstallFailureKind(undefined)).toBe(false);
    expect(isPluginInstallFailureKind(null)).toBe(false);
    expect(isPluginInstallFailureKind(42)).toBe(false);
  });
});

describe("isReinstallFixableFailureKind", () => {
  it("classifies a pre-v6/schema manifest failure as reinstall-fixable", () => {
    expect(isReinstallFixableFailureKind("manifest-validation-error")).toBe(true);
  });

  it("treats an unclassified load failure (undefined) as reinstall-fixable", () => {
    expect(isReinstallFixableFailureKind(undefined)).toBe(true);
  });

  it("classifies app-version incompatibility as NOT reinstall-fixable", () => {
    expect(isReinstallFixableFailureKind("incompatible-app-version")).toBe(false);
  });

  it("classifies host-protocol incompatibility as NOT reinstall-fixable", () => {
    // Reinstall preserves protocol version; compatibility needs a different app or plugin release.
    expect(isReinstallFixableFailureKind("incompatible-host-protocol")).toBe(false);
  });

  it("classifies both process-entry refusals as NOT reinstall-fixable", () => {
    // Reinstall does not change sandbox support or source provenance.
    expect(isReinstallFixableFailureKind("process-entry-unconfined")).toBe(false);
    expect(isReinstallFixableFailureKind("process-entry-requires-pinned-artifact")).toBe(false);
  });

  it("classifies a sandbox grant outside the ceiling as NOT reinstall-fixable", () => {
    // Reinstall preserves grants; narrower updates and approval changes are separate actions.
    expect(isReinstallFixableFailureKind("sandbox-grant-outside-ceiling")).toBe(false);
  });

  it("classifies a marketplace revocation block as NOT reinstall-fixable", () => {
    // Show revocation reasons rather than looping on a reinstall of the same blocked version.
    expect(isReinstallFixableFailureKind("plugin-revoked")).toBe(false);
  });

  it("partitions the full taxonomy without leaving a kind unclassified", () => {
    const fixable = PLUGIN_INSTALL_FAILURE_KINDS.filter((kind) =>
      isReinstallFixableFailureKind(kind),
    );
    const notFixable = PLUGIN_INSTALL_FAILURE_KINDS.filter(
      (kind) => !isReinstallFixableFailureKind(kind),
    );
    expect(fixable).toEqual([
      "manifest-validation-error",
      "untrusted-manifest-path",
      "load-crash",
    ]);
    expect(notFixable).toEqual([
      "incompatible-app-version",
      "incompatible-host-protocol",
      "process-entry-unconfined",
      "process-entry-requires-pinned-artifact",
      "sandbox-grant-outside-ceiling",
      "plugin-revoked",
    ]);
  });
});
