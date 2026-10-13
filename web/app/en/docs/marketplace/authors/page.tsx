import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Package Author Guide" };

const kinds = [
  { kind: "skill", files: "SKILL.md plus scripts/, references/, assets/, LICENSE and NOTICE" },
  { kind: "agent", files: "one AGENTS.md" },
  { kind: "theme", files: "theme.json and an optional preview image; contrast rules are checked" },
  { kind: "font", files: "font.json, LICENSE and font files under files/ (.woff2, .woff, .ttf, .otf)" },
  { kind: "language", files: "locale, language.json and messages.json (interface keys of the English catalog only)" },
  { kind: "provider", files: "provider.json (a provider preset)" },
  { kind: "messaging-connection", files: "connection.json" },
  { kind: "mcp", files: "an npx, uvx or docker launcher with an exact version, a package-local server/ command, Streamable HTTP, or an official MCP server.json" },
  { kind: "plugin", files: "the authority copied from plugin.json and the artifact pins" },
];

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace · Authors"
        title="Package Author Guide — Publishing Is A Merge"
        description="A marketplace is a git repository, and publishing a package means merging a commit into it. There is no upload API, no approval queue and no publisher key: the repository's branch protection is the review."
        tags={["marketplace.json index", "ave-package.json per package", "Versions pinned to commits"]}
      />

      <h2 id="layout">Repository Layout</h2>
      <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-secondary/60 p-4 font-mono text-[13px] leading-relaxed text-ink">{`marketplace.json                      the index
policy/revocations.json               optional — revocations
<kind dir>/<name>/ave-package.json   one descriptor per package
<kind dir>/<name>/...                 the package's files`}</pre>
      <p>
        <code>marketplace.json</code> names the marketplace and lists each package&apos;s <code>kind</code>, <code>name</code> and <code>path</code>.
        A package entry&apos;s <code>versions[]</code> (newest first) pins each <code>version</code> to the <code>commit</code> that published it.
        Names are lowercase and hyphenated, and unique per kind within a marketplace.
      </p>

      <h2 id="kinds">Files Per Kind</h2>
      <p>
        <code>ave-package.json</code> carries <code>schemaVersion: 1</code>, <code>kind</code>, <code>name</code>, <code>version</code>,{" "}
        <code>minAppVersion</code> and a kind-specific <code>payload</code>. SVG is refused in every kind.
      </p>
      <ul>
        {kinds.map((k) => (
          <li key={k.kind}><code>{k.kind}</code> — {k.files}</li>
        ))}
      </ul>

      <h2 id="plugins">Extension Artifacts</h2>
      <StepList
        steps={[
          { title: "release", body: <p>A GitHub release asset, used only with a <code>sha256</code> pin.</p>, badge: "1st" },
          { title: "archive", body: <p>An https zip, also used only with a <code>sha256</code> pin.</p>, badge: "2nd" },
          { title: "tree", body: <p>The package&apos;s <code>plugin.json</code>, <code>dist/</code> and <code>assets/</code> at the pinned commit; nothing else may sit there.</p>, badge: "3rd" },
        ]}
      />
      <p>
        A transport or checksum failure moves to the next rung. A staged <code>plugin.json</code> whose authority fields or{" "}
        <code>minAppVersion</code> disagree with the descriptor stops the install, and a manifest that still declares the retired{" "}
        <code>installPolicy</code> or <code>publisher</code> is refused.
      </p>

      <h2 id="lifecycle">Updating, Yanking And Revoking</h2>
      <ul>
        <li><strong>Update</strong> — publish a new <code>version</code>; users see it after their next sync. New authority needs the user&apos;s explicit decision.</li>
        <li><strong>Yank</strong> — <code>yanked</code> on a <code>versions[]</code> entry stops the version being offered; installs of it stay.</li>
        <li><strong>Staged rollout</strong> — <code>rollout: {"{ percent }"}</code> on a version.</li>
        <li><strong>Revoke</strong> — versions listed in <code>policy/revocations.json</code> are disabled (<code>disable</code>) or uninstalled (<code>uninstall</code>), only where they were installed from this source.</li>
      </ul>

      <Callout tone="tip" title="Check The Repository Before Publishing">
        The app exports its rules as <code>checkMarketplaceRepository</code>. Run it in CI as the official repository does: an empty result
        means the app accepts every package as it stands.
      </Callout>

      <Callout tone="info" title="The Full Formats">
        The app repository&apos;s <code>docs/design/multi-source-git-marketplace.md</code> owns every format; the author&apos;s route is{" "}
        <code>docs/guides/marketplace-publishing.md</code> and local testing is <code>docs/guides/local-marketplace-testing.md</code>.
      </Callout>

      <PageNav />
    </article>
  );
}
