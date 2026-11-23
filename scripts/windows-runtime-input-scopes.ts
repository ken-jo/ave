// Repository source read by computed path. Literal source paths and imports
// are indexed separately. An empty entry means this module takes its paths
// from callers, or reads host/test state rather than repository source.
export const windowsRuntimeInputScopes: Readonly<Record<string, readonly string[]>> = {
  // Workflow discovery and the paths read out of workflow steps and actions.
  "src/__tests__/packaging-discipline-source.test.ts": [".github/**", "scripts/**", "config/**"],
  // Paths to read in the checkout are supplied by individual suites.
  "src/__tests__/test-helpers.ts": [],
  "src/__tests__/support/simulated-win32-drive.ts": [],
  "src/__tests__/support/fixture-owner.ts": [],
  "src/__tests__/support/ave-home-privacy.ts": [],
  "src/__tests__/support/native-executable.ts": [],
  // The shared bundler also accepts entry points supplied by individual suites.
  "src/plugins/isolation/__tests__/child-entry-bundle.ts": ["src/plugins/isolation/plugin-child-main.ts"],
  // Installed executables, host probes, and caller-supplied command lines.
  "src/main/windows-path-kind-launcher.ts": [],
  "src/shared/windows-path-facts.ts": [],
  "src/shared/verified-executable.ts": [],
  "src/lib/shell-resolver.ts": [],
  "src/main/process-group-reaper.ts": [],
  "src/main/managed-child-processes.ts": [],
  "src/permissions/asrt-sandbox.ts": [],
  "src/permissions/mxc-policy-pipe.ts": [],
  "src/permissions/verified-shell-command.ts": [],
  "src/permissions/windows-process-start-time.ts": [],
  // Installation artifacts and interpreter provenance are global inputs.
  "src/main/host-script-runtime.ts": ["scripts/**", "resources/**"],
  "src/main/seed-ave-home-docs.ts": ["resources/**"],
  "src/permissions/srt-win-integrity.ts": ["patches/**", "resources/**"],
  // State under the configured home, workspace, or system policy directory.
  "src/shared/ave-home.ts": [],
  "src/shared/ave-home-configuration.ts": [],
  "src/shared/ave-home-trust.ts": [],
  "src/hooks/hook-disable-state.ts": [],
  "src/hooks/hook-discovery.ts": [],
  "src/lib/admin-policy-file.ts": [],
  "src/data/settings-store.ts": [],
  "src/permissions/operator-container-attestation.ts": [],
  "src/permissions/persisted-policy-version.ts": [],
  "src/audit/sandbox-audit-sink.ts": [],
  "src/audit/jsonl-reader.ts": [],
  "src/audit/audit-logger.ts": [],
  "src/audit/hmac-chain.ts": [],
  "src/tools/file-read-state.ts": [],
  "src/tools/file-read-core.ts": [],
  "src/tools/guarded-file-transfer.ts": [],
};
