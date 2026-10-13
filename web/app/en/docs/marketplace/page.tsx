import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Marketplace" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="Marketplace — Packages From Git Repositories and Folders"
        description="Extensions, MCP servers, skills, agents, themes, fonts, languages, providers and messaging connections come from marketplaces that are git repositories or folders. There is no account and no upload server: the app reads the source, pins what it read to a commit or to the folder's contents, and installs only the files that pin names."
        tags={["The repository is the catalog", "No account needed", "Installs pinned to a commit"]}
      />

      <h2 id="where">Where Is It?</h2>
      <p>
        In <strong>Settings → Marketplace</strong>. Kind tabs split the catalog, the source filter narrows it to one
        marketplace, and the <strong>Installed</strong> tab lists what is on this computer. No sign-in is needed.
      </p>

      <h2 id="sources">Sources — Where Packages Come From</h2>
      <FeatureGrid
        columns={2}
        items={[
          {
            title: "Official (ave)",
            body: <>The marketplace built into the app. Only an official extension installed from the release file this source pins can receive a host secret.</>,
            tone: "teal",
          },
          {
            title: "Managed",
            body: <>An internal marketplace your organization registers through the system policy file. It can name default and required installs; a required package cannot be uninstalled or disabled.</>,
            tone: "ink",
          },
          {
            title: "Custom",
            body: <>A marketplace you add yourself with <strong>Add → Add marketplace…</strong>: a repository address, or a folder on this computer or a network share (see <a href="/en/docs/marketplace/folders">Folder sources</a>).</>,
            tone: "ink",
          },
          {
            title: "Direct",
            body: <><strong>Add → Install from Git URL or folder…</strong> installs one package from a repository or a folder with no marketplace around it.</>,
            tone: "citron",
          },
        ]}
      />
      <p>
        Wherever it came from, a package can do the same things at run time. No package can lock itself, grant itself a
        secret, or revoke another source&apos;s packages. An installed package stays bound to the source it came from and
        updates only from there.
      </p>

      <h2 id="flow">From Adding To Removing</h2>
      <StepList
        steps={[
          {
            title: "Add a marketplace",
            body: <p>Enter the repository address (https, http or ssh) or choose a folder. If the address uses plain http, an internal network or a folder on another computer, the app asks first (see <a href="/en/docs/marketplace/warnings">Warnings and policy</a>). It then reads the source and previews the packages per kind, plus any this app does not accept, with the reason.</p>,
          },
          {
            title: "Install",
            body: <p>Install in the catalog shows the install plan first. An extension lists its permissions, network hosts and secret requests, and installs only after you confirm.</p>,
            badge: "You confirm",
          },
          {
            title: "Update",
            body: <p>The app checks its sources at start-up and once a day. An update that changes nothing you agreed to installs by itself while no conversation is running; one that asks for more waits for your review, which shows the commit range and every change (see <a href="/en/docs/marketplace/updates">Automatic updates</a>).</p>,
          },
          {
            title: "Remove a source, uninstall a package",
            body: <p>Removing a source keeps the packages installed from it, but they no longer receive updates. Uninstall packages from the <strong>Installed</strong> tab.</p>,
          },
        ]}
      />

      <h2 id="links">Install Links</h2>
      <p>
        A link on a web page or in a document can open an install screen: <code>ave://install/&lt;kind&gt;/&lt;name&gt;@&lt;source&gt;</code> opens
        that package in the Marketplace tab, and <code>ave://marketplace/add?url=&lt;repository&gt;</code> opens the add dialog. A link only opens a
        screen; you always confirm the install.
      </p>

      <Callout tone="security" title="What An Install Trusts">
        The app trusts only the commit it synced and the pins that commit carries. An extension&apos;s release file is checked against its pinned
        SHA-256 and an extension taken from the repository tree against its pinned commit; the install receipt records a hash per file, checked
        again before the extension runs. A marketplace can disable or uninstall versions installed from it through <code>policy/revocations.json</code>.
      </Callout>

      <Callout tone="info" title="When Something Is Refused">
        Every refusal says what happened and what to do; <a href="/en/docs/marketplace/troubleshooting">Troubleshooting</a> lists them with what to check.
      </Callout>

      <Callout tone="info" title="Want To Publish A Package?">
        The repository layout and the files per kind are in the <a href="/en/docs/marketplace/authors">package author guide</a>.
      </Callout>

      <PageNav />
    </article>
  );
}
