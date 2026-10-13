import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { MockupFrame } from "@/components/docs/mockup-frame";
import { MessageList } from "@/components/docs/message-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Warnings and Policy" };

const cell = "border border-border p-2.5 align-top";

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="Connection Warnings and Organization Policy"
        description="Plain http, internal network addresses and folders on other computers are allowed, but never silently. Ave asks once, before it connects, says what the risk is, and remembers your answer as a badge. Your organization can turn any of them into a rule."
        tags={["Asked before connecting", "Remembered per source", "Policy can decide"]}
      />

      <Callout tone="info" title="Applies to Ave 0.14.0 and later">
        Earlier versions lack some of the screens and messages on this page, or show them differently.
      </Callout>

      <h2 id="before-connect">Before Ave Connects</h2>
      <p>
        When an address needs a decision, the Add dialog stops before any connection and shows “Before Ave connects”
        with one sentence per risk, then <em>Continue</em> and <em>Cancel</em>. Continue saves your answer with the
        source; its row and its packages then carry a badge saying what you allowed. Nothing is asked again for the same
        source unless its address changes what it is — for example, a host that moves to an internal address.
      </p>
      <MockupFrame title="Add marketplace — 1 · Address">
        <div className="grid gap-2.5 text-[13px]">
          <p className="!my-0 font-medium">Git address or folder</p>
          <p className="!my-0 rounded-md border border-border px-2.5 py-1.5 font-mono text-[12px] [overflow-wrap:anywhere]">
            http://git.lab.example/ave/marketplace.git
          </p>
          <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900">
            <p className="!my-0 font-semibold">Before Ave connects</p>
            <p className="!my-0">
              git.lab.example uses http: the connection is not encrypted, so anyone on the network path can see and change
              what you download. Updates from it are not installed automatically. Continue?
            </p>
            <p className="!my-0">
              git.lab.example is on an internal network (10.0.0.1). This allows only this source&apos;s own server;
              downloads the marketplace points at other internal hosts are asked separately. Continue only if you expect
              this source inside your organization&apos;s network.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <span className="rounded-md px-2 py-0.5">Cancel</span>
              <span className="rounded-md bg-ink px-2 py-0.5 text-white">Continue</span>
            </div>
          </div>
        </div>
      </MockupFrame>

      <h2 id="warnings">What Ave Asks About</h2>
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-secondary text-left">
              <th className={cell}>When</th>
              <th className={cell}>Asked</th>
              <th className={cell}>Badge afterwards</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className={cell}>The address uses plain http</td><td className={cell}>when you add it</td><td className={cell}>Unencrypted (http)</td></tr>
            <tr><td className={cell}>A sign-in would be sent over http</td><td className={cell}>when you add it with a token, or choose <em>Set token…</em></td><td className={cell}>—</td></tr>
            <tr><td className={cell}>The server is on an internal network</td><td className={cell}>when you add it</td><td className={cell}>Internal network</td></tr>
            <tr><td className={cell}>The server is this computer</td><td className={cell}>when you add it</td><td className={cell}>This computer</td></tr>
            <tr><td className={cell}>A marketplace points a download at another internal host</td><td className={cell}>when you install from it (<em>Allow internal downloads</em>)</td><td className={cell}>Internal downloads</td></tr>
            <tr><td className={cell}>The folder is on another computer</td><td className={cell}>when you add it</td><td className={cell}>Network folder</td></tr>
            <tr><td className={cell}>An http source&apos;s automatic updates</td><td className={cell}>when you turn them on (<em>Turn on anyway</em>)</td><td className={cell}>—</td></tr>
          </tbody>
        </table>
      </div>
      <p>The sentences, as Ave shows them:</p>
      <MessageList
        items={[
          {
            tone: "warning",
            label: "Plain http",
            message: (
              <>
                git.lab.example uses http: the connection is not encrypted, so anyone on the network path can see and
                change what you download. Updates from it are not installed automatically. Continue?
              </>
            ),
          },
          {
            tone: "warning",
            label: "A sign-in over http",
            message: (
              <>
                Your sign-in for git.lab.example would travel unencrypted, and anyone on the network path could copy it.
                Continue?
              </>
            ),
            fix: <p>Ave sends no token over http until you allow this, even for a host your organization lists.</p>,
          },
          {
            tone: "warning",
            label: "An internal network address",
            message: (
              <>
                git.lab.example is on an internal network (10.0.0.1). This allows only this source&apos;s own server;
                downloads the marketplace points at other internal hosts are asked separately. Continue only if you
                expect this source inside your organization&apos;s network.
              </>
            ),
            fix: (
              <p>
                When the address is in a range some proxy tools report for every host, the sentence adds “Some proxy
                tools report every address in this range.”
              </p>
            ),
          },
          {
            tone: "warning",
            label: "This computer",
            message: <>localhost is this computer (127.0.0.1). Continue only if you run this server yourself.</>,
          },
          {
            tone: "warning",
            label: "Internal downloads",
            message: (
              <>
                lab asks Ave to download from 10.0.0.2, another internal address. A marketplace that can name internal
                hosts can make Ave send requests into your network, for example to a router&apos;s settings page; a
                later failed check cannot undo a request already sent. Allow internal downloads?
              </>
            ),
          },
          {
            tone: "warning",
            label: "A folder on another computer",
            message: (
              <>
                \\files.example\ave\marketplace is a folder on another computer. Ave signs in to files.example with
                your Windows account to read this folder. Continue?
              </>
            ),
            fix: (
              <p>
                The other forms of this question are on <a href="/en/docs/marketplace/folders#kinds">Folder sources</a>.
              </p>
            ),
          },
          {
            tone: "warning",
            label: "Automatic updates over http",
            message: (
              <>
                Updates from lab arrive over http. Anyone on the network path could replace them with their own code, and
                it would install without asking. Turn on automatic updates anyway?
              </>
            ),
          },
        ]}
      />
      <p>
        A download over http from a marketplace is still checked against the sha256 the marketplace pinned in git; its
        Delivery line in the package sheet says “unencrypted download — verified by the pinned sha256”.
      </p>

      <h2 id="allow-later">Allowing Later</h2>
      <p>
        When a source you already added starts to need a confirmation — its host moved to an internal address, or its
        shared folder is now on another computer — Ave stops contacting it and keeps serving what it read last. Its row
        in <strong>Sources</strong> says <em>Needs your confirmation</em>. When its server now asks for a sign-in over
        http, the row says <em>Auth required</em> instead, and Ave sends no sign-in until you allow it. Either way the
        row offers <em>Allow…</em>, which states the risk again in “Allow this for &lt;source&gt;?” before you choose{" "}
        <em>Allow</em>.
      </p>
      <MessageList
        items={[
          {
            tone: "warning",
            message: (
              <>
                An address this source uses now needs a confirmation the source does not hold, so Ave did not contact
                it. Choose Allow… on its row in Sources to read what it means and allow it.
              </>
            ),
          },
          {
            tone: "warning",
            message: (
              <>
                git.lab.example needs sign-in, and this source uses http, so Ave sends no sign-in to it until you allow
                that. Choose Allow… on the source&apos;s row in Sources, then Set token….
              </>
            ),
          },
        ]}
      />

      <h2 id="refused">What No Confirmation Passes</h2>
      <p>Some addresses are never safe to use, so they are refused outright, whatever you or a marketplace choose:</p>
      <ul>
        <li>an address that leads to a link-local or cloud-metadata address (where a cloud computer keeps its credentials), or to an address no network can reach;</li>
        <li>a marketplace that points a download at this computer;</li>
        <li>a password or token written into the address, and <code>&lt;helper&gt;::</code> addresses that run a program to fetch;</li>
        <li>a link (<code>ave://marketplace/add</code>) that tries to choose a folder on this computer.</li>
      </ul>
      <p>
        Each refusal has its own sentence; they are listed in{" "}
        <a href="/en/docs/marketplace/troubleshooting#network">Troubleshooting</a>.
      </p>

      <h2 id="policy">What Your Organization Can Decide</h2>
      <p>
        An administrator sets these rules in the <code>marketplaces</code> section of the system policy file:{" "}
        <code>/Library/Application Support/Ave/policy.json</code> on macOS, <code>%ProgramData%\Ave\policy.json</code>{" "}
        on Windows and <code>/etc/ave/policy.json</code> on Linux. Marketplace rule changes apply at the next marketplace
        action, with no restart. What a rule decides is shown with a lock and “Set by your organization”, and its sentence
        names the rule and the file.
      </p>
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-secondary text-left">
              <th className={cell}>Key</th>
              <th className={cell}>Effect</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className={cell}><code>allow</code>, <code>block</code></td><td className={cell}>Which sources may be used: <code>host:&lt;host&gt;</code>, a repository URL (ending in <code>*</code> for every repository below it), or <code>path:&lt;folder&gt;</code> for folders (<code>path:/srv/ave/*</code>, <code>path:*</code>). <code>block</code> wins over <code>allow</code>; an <code>allow</code> list with no <code>path:</code> pattern admits no folder.</td></tr>
            <tr><td className={cell}><code>allowHttpHosts</code></td><td className={cell}>Hosts that may use plain http. Hosts the policy lists — here, in <code>allow</code> or as an <code>additional</code> source — need no http, internal-network or this-computer confirmation. A sign-in over http is still asked.</td></tr>
            <tr><td className={cell}><code>requireHttps</code></td><td className={cell}><code>true</code> refuses plain http, except for <code>allowHttpHosts</code>.</td></tr>
            <tr><td className={cell}><code>blockPrivateNetworks</code></td><td className={cell}><code>true</code> refuses internal-network and this-computer addresses, except for hosts the policy lists.</td></tr>
            <tr><td className={cell}><code>allowLocalSources</code></td><td className={cell}><code>false</code> refuses every folder, as a source and as a direct install.</td></tr>
            <tr><td className={cell}><code>allowDirectInstall</code></td><td className={cell}><code>false</code> allows installs from marketplaces only.</td></tr>
            <tr><td className={cell}><code>additional</code></td><td className={cell}>Organization sources, by <code>url</code> or, for a folder, by <code>path</code>. Users cannot remove or hide them; a folder listed here needs no network-folder confirmation.</td></tr>
            <tr><td className={cell}><code>defaultInstalls</code>, <code>requiredInstalls</code></td><td className={cell}>Packages installed for every user; required ones cannot be removed or turned off and always update (see <a href="/en/docs/marketplace/updates#organization">Automatic updates</a>).</td></tr>
            <tr><td className={cell}><code>autoUpdate</code></td><td className={cell}><code>&quot;on&quot;</code> or <code>&quot;off&quot;</code> decides automatic updates for everyone and locks the switches.</td></tr>
          </tbody>
        </table>
      </div>
      <p>
        This system file is also the permission policy. Include a numeric top-level <code>version: 1</code>, even when
        the file only configures <code>marketplaces</code> or <code>service</code>. Without it, Ave requires explicit
        tool approval and locks permission-policy editing in the app. The example below is a complete managed{" "}
        <code>policy.json</code> file.
      </p>
      <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-secondary/50 p-4 text-[12.5px] leading-relaxed">
{`{
  "version": 1,
  "marketplaces": {
    "allow": ["host:git.example.com", "path:/srv/ave/*"],
    "allowHttpHosts": ["git.example.com"],
    "requireHttps": true,
    "blockPrivateNetworks": false,
    "allowLocalSources": true,
    "allowDirectInstall": false,
    "additional": [
      { "id": "team", "url": "http://git.example.com/ave/marketplace.git" },
      { "id": "team-share", "path": "/srv/ave/marketplace" }
    ],
    "autoUpdate": "on"
  }
}`}
      </pre>
      <p>What users see when a rule applies:</p>
      <MessageList
        items={[
          {
            tone: "policy",
            label: "requireHttps",
            message: (
              <>
                Your organization requires https, and http://git.lab.example/ave/marketplace.git uses http. Use the
                source&apos;s https address if it has one, or ask your administrator to list the host; the policy is in
                /Library/Application Support/Ave/policy.json.
              </>
            ),
          },
          {
            tone: "policy",
            label: "blockPrivateNetworks",
            message: (
              <>
                Your organization blocks sources on internal networks and on this computer, and git.lab.example resolves
                to 10.0.0.1. Ask your administrator; the policy is in /Library/Application Support/Ave/policy.json.
              </>
            ),
          },
          {
            tone: "policy",
            label: "allowLocalSources",
            message: (
              <>
                Your organization does not allow folders as sources, so /Users/me/Documents/agent-marketplace cannot be
                read. Ask your administrator; the policy is in /Library/Application Support/Ave/policy.json.
              </>
            ),
          },
          {
            tone: "policy",
            label: "allowDirectInstall",
            message: (
              <>
                Your organization allows installs from marketplaces only, so https://github.com/acme/proofread cannot be
                installed directly. Ask your administrator; the policy is in /Library/Application
                Support/Ave/policy.json.
              </>
            ),
          },
          {
            tone: "policy",
            label: "block",
            message: (
              <>
                Your organization blocks https://github.com/acme/tools (rule host:github.com). Ask your administrator; the
                rule is in /Library/Application Support/Ave/policy.json.
              </>
            ),
          },
          {
            tone: "policy",
            label: "allow",
            message: (
              <>
                Your organization allows only listed sources, and https://github.com/acme/tools is not listed. Ask your
                administrator; the list is in /Library/Application Support/Ave/policy.json.
              </>
            ),
          },
        ]}
      />

      <Callout tone="warn" title="A policy file with a mistake">
        Ave reads the section exactly. An unknown key, a duplicate key or a pattern that does not parse makes the whole
        section invalid, and then only the official marketplace works until the file is fixed: “The organization&apos;s
        marketplace policy cannot be read (…), so only the official marketplace works. Ask your administrator to fix
        it.” Apps up to and including 0.13.0 do not know <code>requireHttps</code>, <code>blockPrivateNetworks</code>,{" "}
        <code>allowLocalSources</code>, <code>path:</code> rules, a folder in <code>additional</code> or{" "}
        <code>autoUpdate</code>, so deploy them only to Ave 0.14.0 and later.
      </Callout>

      <PageNav />
    </article>
  );
}
