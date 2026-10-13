import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Trust & Security — What Protects the User" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Trust & Security"
        title="What Protects the User"
        description="The more automation Ave does, the more the question 'is this safe?' matters to the user. This page gathers, in one place, the safety limits Ave has in place to protect the user."
        tags={["Source verification", "Secret protection", "Runs after consent", "Only on your PC"]}
      />

      <FeatureGrid
        columns={2}
        items={[
          {
            title: "Only pinned files are installed",
            body: <>A marketplace is a git repository, and the app trusts only the commit it synced and the pins that commit carries. An extension&apos;s files are checked against their pinned SHA-256 or commit and are not installed on a mismatch. The install receipt keeps a hash per file, so an extension whose files changed is not loaded.</>,
            tone: "teal",
          },
          {
            title: "A revoked version does not come back",
            body: <>When a marketplace lists a version for revocation (<code>policy/revocations.json</code>), installs of it from that marketplace are disabled or uninstalled on every sync. On the next launch, the last synced revocations apply before any extension loads. One marketplace&apos;s revocations never affect packages installed from another.</>,
            tone: "ink",
          },
          {
            title: "Secrets live in the OS secure store",
            body: <>Secrets like API keys, tokens, and internal session cookies are encrypted and kept in the operating system's secure storage. They are never stored in plaintext on the Ave disk.</>,
            tone: "ink",
          },
          {
            title: "Tool actions follow the approval policy",
            body: <>When the host requires user consent for a tool action, it presents an inline confirmation card or a full dialog. The automatic maintenance connections described below follow their own settings and policy.</>,
            tone: "coral",
          },
          {
            title: "Data stays only on your PC",
            body: <>Conversations, meeting notes, indexed material, memory, and automation records are all kept in the Ave area on the user's PC. External server sync is limited to features the user has explicitly turned on.</>,
            tone: "citron",
          },
          {
            title: "Delegation consent is preserved as a chain",
            body: <>Consent given when delegating autonomous execution to an Agent is preserved as an immutable record chain. Who consented, when, and within what scope can always be reviewed later exactly as it happened.</>,
          },
          {
            title: "Internal-only extensions work only on the internal network",
            body: <>Internal-only extensions automatically block login itself when accessed from outside the corporate network. This is a safeguard against internal credentials leaking out over the wrong network.</>,
          },
        ]}
      />

      <h2 id="plugin-boundary">When an extension fails</h2>
      <ul>
        <li><strong>It leaves a reason instead of disappearing.</strong> An installed extension that fails to load does not silently vanish — it stays in the sidebar's extension list as <strong>an entry naming why it failed</strong>. A manifest that does not match the schema, an app version that is too old, a version the distributor withdrew, and installed files that no longer match their install record each show as a distinct reason, and the ones a reinstall can repair are distinguished from the ones it cannot.</li>
        <li><strong>Some of them run in a separate process.</strong> There is a path that confines an extension to a child process separate from the host, and extensions are being moved onto it one at a time. The details — and <strong>how many take that path today</strong> — are in the <a href="/en/docs/architecture/host-api#boundary">HostApi document</a>.</li>
      </ul>

      <h2 id="audit">Audit log — every action, one line at a time</h2>
      <p>
        Every action Ave performs automatically (tool calls, permission grants, mail sent, automation fired) is recorded as a single line in
        secure storage. Users can open this log anytime to check things like "how many times did Ave touch my mail today?" or "who turned on this automation?"
      </p>
      <ul>
        <li>Split by date, one file per day — easy to search.</li>
        <li>No automatic cleanup by the host. Records are preserved as-is unless the user deletes them directly.</li>
        <li>Sandbox actions (running external code) are kept in a separate log and stored even more conservatively.</li>
      </ul>

      <h2 id="no-fallback">No workarounds</h2>
      <StepList
        steps={[
          {
            title: "Revoked permission stops execution immediately",
            body: <p>Once a granted permission is revoked by the user, any tool that needed it stops immediately on the next call, with no fallback, and asks the user to grant it again.</p>,
          },
          {
            title: "What's disallowed stays disallowed",
            body: <p>Risky actions are never routed around under the name of a "plan B." A disallowed action stays disallowed — this prevents an action the user thought they'd consented to "a while back" from quietly happening again.</p>,
          },
          {
            title: "Only allowed sources are trusted",
            body: <p>Extensions reach only domains declared in their manifests and permitted by host policy. Built-in services use the app&apos;s own fixed sources, described below; those sources do not grant extensions additional access.</p>,
          },
        ]}
      />

      <h2 id="outbound">Connections the app opens by itself</h2>
      <p>
        Besides the providers, extensions and servers you connect, the app opens a few connections of its own, such as the
        update check. One of them, on by default, refreshes context-window and output-limit metadata from
        <a href="https://models.dev"> models.dev</a>. Endpoint reports and user settings also determine the effective limits.
        Usage pricing still uses the app&apos;s existing price table and user overrides.
      </p>
      <ul>
        <li><strong>Where:</strong> only <code>https://models.dev/api.json</code>, a public document. The interactive app checks at boot and hourly, but requests at most once a day; failed attempts also count. Headless runs send no refresh request.</li>
        <li><strong>What is sent:</strong> a GET with <code>Accept: application/json</code> and, when available, the previous ETag in <code>If-None-Match</code>. It carries no account, API key, session authentication, cookie, prompt, file or conversation. The server sees your IP address and ordinary transport headers, including the user agent and language header.</li>
        <li><strong>How it is checked:</strong> the host&apos;s public-address guard refuses internal addresses, and redirects are refused. Certificate errors do not trigger a cleartext retry. Headers and body together must arrive within 15 seconds; the body is capped at 16 MB (16,777,216 bytes) after decompression. Invalid downloads preserve the usable catalog. At the next launch, the app uses a verified cache no older than its bundled catalog, or the bundle. An existing pin takes precedence.</li>
        <li><strong>Cache:</strong> verified copies stay on your computer. Publication retains at most five catalog files, including the current and preceding usable copies. An older hash pin may be evicted; keep a separate catalog file and pin its absolute path for long-term reproducibility. An unusable explicit pin prevents startup.</li>
        <li><strong>How to turn it off:</strong> Settings → Model → <strong>Model catalog</strong> → turn off <em>Refresh the catalog daily</em>. The next launch still follows the cache and bundle selection above. An administrator can turn refresh off with <code>{`{ "modelCatalog": { "refresh": "off" } }`}</code> in the system policy file; malformed or unreadable policy also disables refresh. A launcher can pin <code>AVE_MODEL_CATALOG</code> to <code>bundled</code>, a retained copy&apos;s sha256, or an absolute catalog-file path, which disables refresh too.</li>
      </ul>
      <p>This is a fixed data source of the app itself; it does not widen what extensions or tools may reach.</p>

      <Callout tone="security" title="Summary — what the user can check">
        <ul className="my-1 list-disc pl-5">
          <li>Every action Ave took today — the audit log.</li>
          <li>Currently active permissions / delegations / automations — the settings screen.</li>
          <li>The types of secrets each extension holds — Settings → Extensions → Permission management.</li>
          <li>The time of the last automatic update and the version before it — Settings → App → Update status.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
