import { createHash } from "node:crypto";

// Repository source read by computed path. Literal source paths and imports
// are indexed separately. Empty inputs mean this module takes its paths
// from callers, or reads host/test state rather than repository source.
//
// Each digest covers the reader's runtime tokens and those of every test,
// test/ or scripts/ helper it reaches through imports, at the audit. Once
// any of them changes, the planner ignores the declared inputs and keeps every
// suite that reaches the reader until the scope is audited again.
//
// `readers` names exports that read a path their caller passes. The scope
// holds only for literal arguments: a module that calls one of them with a
// computed argument, or passes it on as a value, is an unbounded reader itself.
export type WindowsRuntimeInputScope = {
  readonly digest: string;
  readonly inputs: readonly string[];
  readonly readers?: readonly string[];
};

type DigestModule = { readonly tokens: readonly string[]; readonly dependencies: readonly { readonly file: string }[] };
const HELPER_MODULE = /(?:^|\/)__tests__\/|^test\/|^scripts\//u;

export function windowsReaderDigest(file: string, modules: ReadonlyMap<string, DigestModule>): string | undefined {
  if (!modules.has(file)) return undefined;
  const reached = new Set([file]);
  for (const current of reached) {
    for (const { file: dependency } of modules.get(current)?.dependencies ?? []) {
      if (modules.has(dependency)) reached.add(dependency);
    }
  }
  const covered = [...reached].filter(path => path === file || HELPER_MODULE.test(path)).sort();
  const hash = createHash("sha256");
  for (const path of covered) hash.update(`${path}\0${(modules.get(path)?.tokens ?? []).join("\0")}\0\0`);
  return hash.digest("hex");
}

export const windowsRuntimeInputScopes: Readonly<Record<string, WindowsRuntimeInputScope>> = {
  // Workflow discovery and the paths read out of workflow steps and actions.
  "src/__tests__/packaging-discipline-source.test.ts": { digest: "98694ad95851c0c87a51f709ba87df6a42b6f587c8361d2af20d592ee99790e0", inputs: [".github/**", "scripts/**", "config/**"] },
  // Paths to read in the checkout are supplied by individual suites.
  "src/__tests__/test-helpers.ts": { readers: ["readRepoFile", "inspectFile"], digest: "7145da91054e911828efbfbcbd6f053c448b1908870cf9478736357bcbf788b9", inputs: [] },
  "src/__tests__/support/simulated-win32-drive.ts": { digest: "fcb6d6c9006a28c8f04fe65f8fa9dcb784aa9836fad0e6895b359eecc75eb896", inputs: [] },
  "src/__tests__/support/fixture-owner.ts": { digest: "87e96801cebcfefc0d7ae8d4ba189196ce49d1b62ab9401e8a34e10b50fb44b8", inputs: [] },
  "src/__tests__/support/ave-home-privacy.ts": { digest: "db5e0a62c5699617d2964ec8cf7ea3fc649e1eee4a594fdb39a46b1bad373ce3", inputs: [] },
  "src/__tests__/support/native-executable.ts": { digest: "5e93933124fbcdefed78d15e0ea23c4c1237525b5e80db6c7ae96253eded69c9", inputs: [] },
  // The shared bundler also accepts entry points supplied by individual suites.
  "src/plugins/isolation/__tests__/child-entry-bundle.ts": { readers: ["buildMainBoundaryBundle"], digest: "28ed644c3a152d4cd22e47fcf82c907e3010f8cb08fba967a6cb3047e21c375e", inputs: ["src/plugins/isolation/plugin-child-main.ts"] },
  // Installed executables, host probes, and caller-supplied command lines.
  "src/main/windows-path-kind-launcher.ts": { digest: "38e9f3b8319286f0874c29b71a04d1741f2a8ff9956de42b4bbfd8ac383bee72", inputs: [] },
  "src/shared/windows-path-facts.ts": { digest: "dee11c6c152d167eb7e7164093b55bff5d0c085e99c3537738cce76c0222a28c", inputs: [] },
  "src/shared/verified-executable.ts": { digest: "81f1d355f0a367ab1013710f1abe53cd299cfb27741dd3b59e689575900d7fc9", inputs: [] },
  "src/lib/shell-resolver.ts": { digest: "0e4225972fbcc61e3e08665e7b38b2e1eaa7762f82d767e55ccf91e3a28b1d47", inputs: [] },
  "src/main/process-group-reaper.ts": { digest: "a3b25888fd306f4817ad28084e57e9f4fd47fa1447389f700f255556fbe5c66d", inputs: [] },
  "src/main/managed-child-processes.ts": { digest: "7c1a1b7534ec486b3a9fe1963e7011c5c7bd4054dd7cb0a593f5caf31f97077f", inputs: [] },
  "src/permissions/asrt-sandbox.ts": { digest: "80ae4fa5fdaa49328b238bb95c5a219d7d8ac363b9bbc8897f9c7ae3bb03c6f8", inputs: [] },
  "src/permissions/mxc-policy-pipe.ts": { digest: "ab05ecd295482593c5ea7da34dc8e65961081a6ee583b869ca4a4a611c310d4c", inputs: [] },
  "src/permissions/verified-shell-command.ts": { digest: "b66892469f002658e3a383a2faa67f923d92da290985416298918695e4ffedc6", inputs: [] },
  "src/permissions/windows-process-start-time.ts": { digest: "10f2344580f1578262ac8058bf637b5674baa1736bbb57129cb324db69491fda", inputs: [] },
  // Resolves the Codex executable chain, CODEX_HOME/cap_sid and a private temporary directory, and probes them with /bin/ls or PowerShell.
  "src/main/codex-executable-location.ts": { digest: "db53d8742f879d204b0494645dd8ae9308a0d76acdd1f42d67ae3f5d4bfb07cf", inputs: [] },
  // Renames, restores access to and removes installed plugin trees at caller-supplied paths with /bin/chmod and /usr/bin/chflags.
  "src/plugins/installed-entry-fs.ts": { digest: "c020f3a1e0034db145826b925404132d40f2f1a95671e31d742aae8f6e85f6d0", inputs: [] },
  // Installation artifacts and interpreter provenance are global inputs.
  "src/main/host-script-runtime.ts": { digest: "a90385f1d977fb5f76243d5507d958da1268f097c2d1f74563d69fde087b2301", inputs: ["scripts/**", "resources/**"] },
  "src/main/seed-ave-home-docs.ts": { digest: "32d6f553303d8fead006225a1ed5415741db97c8b33e7d3063acdd3055dd6ff6", inputs: ["resources/**"] },
  "src/permissions/srt-win-integrity.ts": { digest: "e85b1a4dbd55dc73e95f2969838aad695cc7923e3b8769753bb0fcdde0d0659e", inputs: ["patches/**", "resources/**"] },
  // State under the configured home, workspace, or system policy directory.
  "src/shared/ave-home.ts": { digest: "41bf2e25b34d75274c787028149966e70b611e9b30d3b8361b2826c3ac362bdb", inputs: [] },
  "src/shared/ave-home-configuration.ts": { digest: "602fd77f133dccc22040d83fda664d229edce77cb8b0b81b3c211a896dc86de9", inputs: [] },
  "src/shared/ave-home-trust.ts": { digest: "14384c6562ad41dd4f1d84d0d53d36624cc3b9be3c5ceed051adf43c382a6123", inputs: [] },
  "src/hooks/hook-disable-state.ts": { digest: "7094f1582e14c8ce045812ab651cc90408fe6232e41ce906f09059e98bf7c9a5", inputs: [] },
  "src/hooks/hook-discovery.ts": { digest: "8fcc54d01982bb0f4b63d0bc9452a7c740ee3ac3349528c99242fc5318cd7f9b", inputs: [] },
  "src/lib/admin-policy-file.ts": { digest: "e9cfe715d550eef9a07b864f5f6d5fdfab894f0beb00618484dd95b080754e36", inputs: [] },
  "src/data/settings-store.ts": { digest: "c16e5fbcc32baf813085b4b772b6e91c0dbf29bd62a8acce795265c378421ef1", inputs: [] },
  "src/permissions/operator-container-attestation.ts": { digest: "0aa623b5bb30115ba8e4703ba8e145f124eff172033cd97a5455fb77500338f2", inputs: [] },
  "src/permissions/persisted-policy-version.ts": { digest: "5bc8b0b0d8737bc44c13670e96127589a812fe726af1f5e21505dcd24b65f085", inputs: [] },
  "src/audit/sandbox-audit-sink.ts": { digest: "d4d19682382a42a55ca5efb2376e332449f05c6bc26337520a17f21dfecd5f3d", inputs: [] },
  "src/audit/jsonl-reader.ts": { digest: "35ae39fd199ab36ceb510095cbb1fe0e008a7f25edddde9acd0485672d5560dd", inputs: [] },
  "src/audit/audit-logger.ts": { digest: "2d2ed4fe13d18605e30b18ba67ebd8a4ba29124dc9605ae26f40ab4af223bf1b", inputs: [] },
  "src/audit/hmac-chain.ts": { digest: "c7f5ea722c9f08a77c1ed08a796a07cb25d2b42c8417513a562e428c2b329cc1", inputs: [] },
  "src/tools/file-read-state.ts": { digest: "33d3f5436bf976a0adc3bc96c45426e9dfab9a98d0a3e11caa7557bfbc151fe2", inputs: [] },
  "src/tools/file-read-core.ts": { digest: "65d85b975881c7001ce65fdc4cd21ef1f9d4dbd38a28d8643833ec19292228dd", inputs: [] },
  "src/tools/guarded-file-transfer.ts": { digest: "067e37dca4e3a60725f827452b61506df6f7d55d671458a9c8cf39c97ef7ab3f", inputs: [] },
};
