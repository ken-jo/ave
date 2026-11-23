import { createHash } from "node:crypto";

// Repository source read by computed path. Literal source paths and imports
// are indexed separately. Empty inputs mean this module takes its paths
// from callers, or reads host/test state rather than repository source.
//
// Each digest covers the reader's runtime tokens at the audit. Once the
// reader changes, the planner ignores its inputs and keeps every suite that
// reaches the reader until the scope is audited again and the digest updated.
export type WindowsRuntimeInputScope = { readonly digest: string; readonly inputs: readonly string[] };

export function windowsReaderDigest(tokens: readonly string[]): string {
  return createHash("sha256").update(tokens.join("\0")).digest("hex");
}

export const windowsRuntimeInputScopes: Readonly<Record<string, WindowsRuntimeInputScope>> = {
  // Workflow discovery and the paths read out of workflow steps and actions.
  "src/__tests__/packaging-discipline-source.test.ts": { digest: "206e0c59bac7d11f9b79aa1e08fb6a95ec47057a442b505e7a7da07f3e0cb10b", inputs: [".github/**", "scripts/**", "config/**"] },
  // Paths to read in the checkout are supplied by individual suites.
  "src/__tests__/test-helpers.ts": { digest: "0e56e2e32c05fabc7225f489cd39d83f03a880f1c7d585fbfd7ea7c5fea49308", inputs: [] },
  "src/__tests__/support/simulated-win32-drive.ts": { digest: "de9ce40935bb37a019336f26ea0e5690581e2acf63e945640df213881e13e2e4", inputs: [] },
  "src/__tests__/support/fixture-owner.ts": { digest: "e979ea0df24377aba141246d2b88043ed35a7dd2ba8d35d933b324c0bcdb035b", inputs: [] },
  "src/__tests__/support/ave-home-privacy.ts": { digest: "dff80fe63cdc7f9859a44d0fbe103b9106f86919249ea33d2704fce13d666cf7", inputs: [] },
  "src/__tests__/support/native-executable.ts": { digest: "71b896e066094fcefba41202939912d4bf0a1f6c1ed9ce2da878f54b576a2e99", inputs: [] },
  // The shared bundler also accepts entry points supplied by individual suites.
  "src/plugins/isolation/__tests__/child-entry-bundle.ts": { digest: "e3e122c50e6993414e7e730a40a1c60bb9fb964bb3e902511087368c2bc5ece9", inputs: ["src/plugins/isolation/plugin-child-main.ts"] },
  // Installed executables, host probes, and caller-supplied command lines.
  "src/main/windows-path-kind-launcher.ts": { digest: "f268abea4345d23d75691749f846bc5cf8bbe794d46a19d5c8f5fc82a649adcf", inputs: [] },
  "src/shared/windows-path-facts.ts": { digest: "2695302c82fab2e3ef7ad22c1f8e6e2be087447d52ec9d0076bb97253c2eb0c8", inputs: [] },
  "src/shared/verified-executable.ts": { digest: "842188d90565cc4aec9c3fa4290c27184ad8a9920b3357080b6fea957e4b0f4b", inputs: [] },
  "src/lib/shell-resolver.ts": { digest: "f31f45da15872a92fa219bb4e7c274800ebf6c2a5354d3b2715ba9072935a4aa", inputs: [] },
  "src/main/process-group-reaper.ts": { digest: "162d7e248ace85fe35a02b4f56db5b6d34d4e883c9a70ba484b725a2cc332ff5", inputs: [] },
  "src/main/managed-child-processes.ts": { digest: "2cccf803a78b95461dfcc0a0d63d2d527937b00a402df7d4b247be9404e07e10", inputs: [] },
  "src/permissions/asrt-sandbox.ts": { digest: "ef6b1c5635c77543c2f77a61f6aea3a29109aa60e943049c6d8e8d0abb1d243e", inputs: [] },
  "src/permissions/mxc-policy-pipe.ts": { digest: "ba872fabf25d82d2f69c8476ed1599cd1f3693f255c8c2bb4c530c6fe02e6fac", inputs: [] },
  "src/permissions/verified-shell-command.ts": { digest: "66b2bbaae48bb00432528998b52988ed6d766bdc043d2572890509f0a9cf26ac", inputs: [] },
  "src/permissions/windows-process-start-time.ts": { digest: "4476ee614bb958c124e0a563e199698cc4dc300badeb080c991d5daf4d69dcd4", inputs: [] },
  // Resolves the Codex executable chain, CODEX_HOME/cap_sid and a private temporary directory, and probes them with /bin/ls or PowerShell.
  "src/main/codex-executable-location.ts": { digest: "070abf3e0bdfaa76da9f22d5d10a4d34a0798fcc123c51591d18fe99b0c4e3ff", inputs: [] },
  // Renames, restores access to and removes installed plugin trees at caller-supplied paths with /bin/chmod and /usr/bin/chflags.
  "src/plugins/installed-entry-fs.ts": { digest: "03f9ca10298b322f1becf9b54e27db58027a898fb3cab27d62d313af4399bf41", inputs: [] },
  // Installation artifacts and interpreter provenance are global inputs.
  "src/main/host-script-runtime.ts": { digest: "a81b01ccadf4b001f72019255808470ebca77f81b08626cf7aa28ee75f7aabb2", inputs: ["scripts/**", "resources/**"] },
  "src/main/seed-ave-home-docs.ts": { digest: "a517e147b43901cbb921d3a17d7ea43da3ec7b1a8c5a341913caf81f0e88be9a", inputs: ["resources/**"] },
  "src/permissions/srt-win-integrity.ts": { digest: "50f1ce68b1780ee4c719a5131e1a401a4e1197715626eb2bba13c06f8a4b6e81", inputs: ["patches/**", "resources/**"] },
  // State under the configured home, workspace, or system policy directory.
  "src/shared/ave-home.ts": { digest: "88273c32b37ec2fb4277a06f22b3486a5224169c950cc186e3fb5a13c04ffb8c", inputs: [] },
  "src/shared/ave-home-configuration.ts": { digest: "a3802ebff722192d33f704f1756cc932f94de31e5570c686437b9d20f28f18c0", inputs: [] },
  "src/shared/ave-home-trust.ts": { digest: "1aa3cb71a16f8e42594dea22c0ee8c74f04c28e59d4b78a7e91d9140b3ef0222", inputs: [] },
  "src/hooks/hook-disable-state.ts": { digest: "a360a38e71538c9b8b776ca34c737c25469c3ed9d6bd8e9af159e7077dccc222", inputs: [] },
  "src/hooks/hook-discovery.ts": { digest: "decb8d0904fc18350c361ce8184435486e44abb00f0626109869ac2f935cc486", inputs: [] },
  "src/lib/admin-policy-file.ts": { digest: "96a23392922c1ceb12e822c053467d2a9119490f32a33ac56c3f43c8c47d6454", inputs: [] },
  "src/data/settings-store.ts": { digest: "040fb4338e1d8605a6d8cea56ef57746ef752fb937a91717ed3a801953439459", inputs: [] },
  "src/permissions/operator-container-attestation.ts": { digest: "58c851fdf2f4f7e91ebf403286e46ede0c114d367346e6c56d55b53342514b3f", inputs: [] },
  "src/permissions/persisted-policy-version.ts": { digest: "8b5c0a4c8e3bae766a260955beacf39737f5bf475824bd54b0d63041c3ae0466", inputs: [] },
  "src/audit/sandbox-audit-sink.ts": { digest: "1a2cc5790fa9760d2cdde552030b1b579fa66a7193af5d0e3a5b88e41b22be29", inputs: [] },
  "src/audit/jsonl-reader.ts": { digest: "341c4169d4d039a9eafc4e73118226903fab2fb6137153d4f7cfa260d78a2184", inputs: [] },
  "src/audit/audit-logger.ts": { digest: "2703de4060bee36fa6a483ca98ae471c5df3c8b2c033375ff3284ebd9f143191", inputs: [] },
  "src/audit/hmac-chain.ts": { digest: "a1f6516385703753306ee61dd36918c795fb67fc118a4424106e68b4c0214f36", inputs: [] },
  "src/tools/file-read-state.ts": { digest: "dbdbecec8832e27bea558440d650e25af07a101b94db250c331bb38de3e064d0", inputs: [] },
  "src/tools/file-read-core.ts": { digest: "92178da06132654d306d95b7ccad2bad2bac9995926bcef825d6f59586f25afc", inputs: [] },
  "src/tools/guarded-file-transfer.ts": { digest: "d24fe031dfc78d26ad1f7dee5aef861e5aa421c6b428b385a139a2db6170d514", inputs: [] },
};
