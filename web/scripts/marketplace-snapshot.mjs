// Writes lib/marketplace.json: the official marketplace's catalog, as the site uses it.
//
//   node scripts/marketplace-snapshot.mjs <commit>
//
// The site reads the catalog at one recorded commit of ken-jo/agent-marketplace
// (public), so a build never depends on the network and every package the pages
// name exists in the catalog at that commit. Re-run with a newer commit to refresh.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = "ken-jo/agent-marketplace";
const commit = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error("usage: node scripts/marketplace-snapshot.mjs <40-hex commit of ken-jo/agent-marketplace>");
  process.exit(2);
}
const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${commit}/marketplace.json`);
if (!res.ok) throw new Error(`marketplace.json at ${commit}: HTTP ${res.status}`);
const catalog = await res.json();
if (catalog.schemaVersion !== 2 || !Array.isArray(catalog.packages)) throw new Error("unexpected marketplace.json shape");

const packages = catalog.packages.map((p) => {
  const v = p.versions.find((x) => x.version === p.latest);
  if (!v) throw new Error(`${p.name}: latest ${p.latest} is not among its versions`);
  const out = {
    kind: p.kind,
    name: p.name,
    displayName: p.displayName,
    description: p.description,
    path: p.path,
    version: v.version,
    versions: p.versions.length,
    commit: v.commit,
    minAppVersion: v.minAppVersion,
    publishedAt: v.publishedAt,
  };
  if (v.hostProtocol) out.hostProtocol = v.hostProtocol;
  if (v.artifact?.release) out.artifact = { tag: v.artifact.release.tag, asset: v.artifact.release.asset, sha256: v.artifact.release.sha256 };
  if (v.authority?.networkAccess?.allowedDomains) out.allowedDomains = v.authority.networkAccess.allowedDomains;
  return out;
});
const counts = {};
for (const p of packages) counts[p.kind] = (counts[p.kind] ?? 0) + 1;

const snapshot = {
  source: { repo: REPO, commit, name: catalog.name, displayName: catalog.displayName },
  counts,
  packages: packages.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
};
const file = fileURLToPath(new URL("../lib/marketplace.json", import.meta.url));
writeFileSync(file, JSON.stringify(snapshot, null, 1) + "\n");
console.log(`wrote ${file}: ${packages.length} packages`, counts);
