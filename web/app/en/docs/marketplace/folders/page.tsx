import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { MockupFrame } from "@/components/docs/mockup-frame";
import { MessageList } from "@/components/docs/message-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Folder Sources" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="Folder Sources — A Marketplace in a Folder"
        description="A folder on this computer or on a network share can be a marketplace, or hold a single package. Ave reads it where it is, without git, and installs exactly what you reviewed."
        tags={["No git needed", "Read in place", "Installs what you reviewed"]}
      />

      <Callout tone="info" title="Applies to Ave 0.14.0 and later">
        Earlier versions lack some of the screens and messages on this page, or show them differently.
      </Callout>

      <h2 id="when">When a Folder Helps</h2>
      <p>
        A folder is the shortest way to share packages with a team that already shares files, to try packages you are
        writing before you publish them to git, or to install on a computer without git or without internet access. A
        folder source works like a git source: its packages appear in the catalog, carry the source&apos;s name, and stay
        bound to it. Only the way Ave reads it differs.
      </p>

      <h2 id="add">Adding a Folder</h2>
      <StepList
        steps={[
          {
            title: "Open the Add dialog",
            body: (
              <p>
                In <strong>Settings → Marketplace</strong>, choose <strong>Add → Add marketplace…</strong> for a folder of
                packages, or <strong>Add → Install from Git URL or folder…</strong> for a folder that holds one package.
              </p>
            ),
          },
          {
            title: "Choose the folder",
            body: (
              <>
                <p>
                  <em>Choose folder…</em> opens your system&apos;s folder dialog. You can also type the full path — starting
                  with <code>/</code>, <code>~</code> or a drive letter — a network path such as{" "}
                  <code>\\server\share\marketplace</code>, or a <code>file:</code> URL. The dialog then says “A folder is
                  read as it is, so it takes no branch, package folder or sign-in.”
                </p>
                <p>
                  Git is not needed. When git is missing, the dialog&apos;s first step still offers <em>Choose folder…</em>{" "}
                  with “Adding a folder does not need git.”
                </p>
              </>
            ),
          },
          {
            title: "Confirm a network folder",
            badge: "Network folders only",
            body: (
              <p>
                A folder on another computer is asked about first, under “Before Ave connects”, with{" "}
                <em>Continue</em> and <em>Cancel</em>. Nothing is read until you continue. See{" "}
                <a href="#kinds">the kinds of folders</a> below.
              </p>
            ),
          },
          {
            title: "Review and add",
            body: (
              <p>
                The review shows the folder, the contents Ave read, how many packages of each kind it holds and its
                badge. Give the source a name and choose <em>Add marketplace</em>. Adding installs nothing; each
                package is reviewed when you install it.
              </p>
            ),
          },
        ]}
      />

      <MockupFrame title="Add marketplace — 2 · Review">
        <div className="grid gap-2.5 text-[13px]">
          <p className="!my-0 font-mono text-[12px] [overflow-wrap:anywhere]">Folder /Users/me/Documents/agent-marketplace</p>
          <p className="!my-0">
            <span className="font-semibold">Team Marketplace</span>
            <span className="text-muted-foreground"> · owner Platform Team</span>
          </p>
          <p className="!my-0 text-[12px] text-muted-foreground">Contents 3f9a1c2</p>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            <span className="rounded-md border border-border px-2 py-0.5">2 Extensions</span>
            <span className="rounded-md border border-border px-2 py-0.5">4 Skills</span>
          </div>
          <p className="!my-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            Packages that can run code on this computer: 2. Adding the source installs nothing. Each extension or MCP
            server asks for its permissions when you install it.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">Local folder</span>
          </div>
          <p className="!my-0 text-[12px] text-muted-foreground">
            Changes in this folder are picked up at start-up, every few hours and on Refresh.
          </p>
        </div>
      </MockupFrame>

      <p>
        If you typed a path that passes through a link, the review names both: “You entered ~/ave. A link on that path
        leads here, so Ave reads this folder.” The source is bound to the folder the link led to, not to the link.
      </p>

      <h2 id="kinds">Local, Removable, Cloud-Synced and Network Folders</h2>
      <FeatureGrid
        columns={2}
        items={[
          {
            title: "A folder on this computer",
            body: (
              <>
                Read without a question and marked <strong>Local folder</strong>: “Read in place from this computer, never
                copied: changes are picked up at start-up, every few hours and on Refresh.”
              </>
            ),
            tone: "teal",
          },
          {
            title: "A removable drive",
            body: (
              <>
                A USB stick or external disk is a local folder while it is connected. When it is not, the source row
                says <em>Folder not found</em>, the packages read last stay available, and the next read after you
                reconnect the drive picks it up again.
              </>
            ),
            tone: "ink",
          },
          {
            title: "A cloud-synced folder",
            body: (
              <>
                A folder that a cloud sync service keeps in step with this computer is read like a local
                folder. A file that is only in the cloud cannot be read until it is downloaded, so keep the folder
                available offline.
              </>
            ),
            tone: "ink",
          },
          {
            title: "A folder on another computer",
            body: (
              <>
                A network path (<code>\\server\share</code>), a mapped network drive on Windows, or an on-demand mount
                such as <code>/Network/…</code> or <code>/net/&lt;host&gt;/…</code> is a network folder. It is asked about
                once and marked <strong>Network folder</strong>. A share you mounted yourself (for example under{" "}
                <code>/Volumes</code>) was signed in to when you mounted it, so it is read as a local folder.
              </>
            ),
            tone: "citron",
          },
        ]}
      />
      <p>The network-folder question is one of these, depending on what Ave can tell about the folder:</p>
      <MessageList
        items={[
          {
            tone: "warning",
            label: "A network path or mapped drive (Windows)",
            message: (
              <>
                \\files.example\ave\marketplace is a folder on another computer. Ave signs in to files.example with
                your Windows account to read this folder. Continue?
              </>
            ),
          },
          {
            tone: "warning",
            label: "A drive Windows cannot place",
            message: (
              <>
                Z:\marketplace is on a drive that is not a disk of this computer, so it may be a folder on another
                computer. Ave would sign in to that server with your Windows account to read it. Continue?
              </>
            ),
          },
          {
            tone: "warning",
            label: "An on-demand mount (macOS, Linux)",
            message: (
              <>
                /Network/Servers/files.example/ave is a folder on another computer (files.example), mounted on demand.
                Reading it connects to that server. Continue?
              </>
            ),
          },
        ]}
      />

      <h2 id="sources">In the Sources List</h2>
      <p>
        A folder source&apos;s row shows <em>Folder</em> and its path (shortened in the middle when long; the full path
        is in the tooltip), <code>folder · &lt;revision&gt;</code> for the contents it read, and “read &lt;time&gt;”
        after a successful read. In place of <em>Set token…</em> it offers <em>Show in Finder</em> (
        <em>Show in Explorer</em> on Windows, <em>Show in file manager</em> on Linux).
      </p>
      <MockupFrame title="Settings → Marketplace → Sources">
        <div className="grid gap-2 text-[13px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">team-share</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">Added by you</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">Local folder</span>
          </div>
          <p className="!my-0 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
            Folder <span className="font-mono">/Users/me/Documents/agent-marketplace</span>
          </p>
          <p className="!my-0 text-[12px]">
            <span className="font-mono">folder · 3f9a1c2</span>
            <span className="text-muted-foreground"> · read 2 min ago · Up to date</span>
          </p>
          <div className="flex flex-wrap gap-2 text-[12px]">
            <span className="rounded-md border border-border px-2 py-0.5">Refresh</span>
            <span className="rounded-md border border-border px-2 py-0.5">Show in Finder</span>
            <span className="rounded-md border border-border px-2 py-0.5 text-red-700">Remove source</span>
          </div>
        </div>
      </MockupFrame>
      <p>Two more badges mark a folder that needs your attention:</p>
      <MessageList
        items={[
          {
            tone: "warning",
            label: "Network folder, not allowed",
            message: (
              <>
                This folder is now on another computer, which you have not allowed for this source, so Ave does not read
                it. Choose Refresh on its row in Sources, then Allow… if you trust that computer.
              </>
            ),
          },
          {
            tone: "warning",
            label: "Location unknown",
            message: (
              <>
                Ave cannot tell whether this folder is on another computer because its folder classifier is missing or
                broken. Reinstall Ave.
              </>
            ),
          },
        ]}
      />

      <h2 id="changes">How Changes Are Picked Up</h2>
      <ul>
        <li>
          Ave reads the folder at start-up, every few hours and when you choose <em>Refresh</em>. Editing any file a
          package installs changes the folder&apos;s revision, and the changed package is offered as an update, even when
          its version number stayed the same.
        </li>
        <li>
          A read that fails keeps the contents read last, and the row names the reason — <em>Folder not found</em>,{" "}
          <em>Folder unreadable</em> or <em>Folder moved</em> — with a sentence saying what to do (see{" "}
          <a href="/en/docs/marketplace/troubleshooting#folders">Troubleshooting</a>).
        </li>
        <li>
          A source stays bound to the folder it was added with. If the path later leads somewhere else, or the folder
          was replaced by another one, Ave stops reading it instead of reading the new folder.
        </li>
        <li>No git command and no program in the folder ever runs while Ave reads it.</li>
      </ul>

      <h2 id="install">What Installs From a Folder</h2>
      <ul>
        <li>
          <strong>One version.</strong> “Only the version in the folder can be installed: a folder holds one version,
          the one its files declare.”
        </li>
        <li>
          <strong>What you reviewed.</strong> The review is bound to the contents it read: “Bound to the folder&apos;s
          contents 3f9a1c2: what you review here is what installs, even if the folder changes”. An edit made after you
          opened the review is offered as the next update.
        </li>
        <li>
          <strong>Built files only.</strong> “A folder installs the built files it holds, as they are: nothing is
          downloaded or built on this computer, and a declared release is not used.” An extension installs{" "}
          <code>plugin.json</code>, <code>dist/</code> and <code>assets/</code>; the review lists what is left out.
        </li>
        <li>
          <strong>Files inside the folder.</strong> A link must stay inside the folder. Version-control data and system
          files (<code>.git/</code>, <code>.DS_Store</code>, <code>._*</code>, <code>Thumbs.db</code>,{" "}
          <code>desktop.ini</code>) are skipped.
        </li>
        <li>
          <strong>Extensions with their own program.</strong> An extension that runs a separate program needs a
          release or archive pinned by its sha256, so it installs from a git marketplace, not from a folder.
        </li>
      </ul>

      <h2 id="overlap">One Folder, One Source</h2>
      <p>
        A folder can belong to one source only, and folder sources cannot overlap. A refused folder names the source in
        the way and offers <em>Show &lt;id&gt;</em>, which closes the dialog and marks that source in Sources.
      </p>
      <MessageList
        items={[
          {
            message: (
              <>
                /Users/me/Documents/agent-marketplace is already added as team-share. Use team-share, or remove it before
                adding this folder again.
              </>
            ),
          },
          {
            message: (
              <>
                Folder sources cannot overlap: /Users/me/Documents/agent-marketplace/skills lies inside
                /Users/me/Documents/agent-marketplace, which is already added as team-share. Use team-share, or remove it
                and add the folder you want.
              </>
            ),
          },
          {
            message: (
              <>
                Folder sources cannot overlap: /Users/me/Documents contains /Users/me/Documents/agent-marketplace, which is
                already added as team-share. Remove team-share first, or add a folder that does not contain it.
              </>
            ),
          },
        ]}
      />

      <Callout tone="security" title="A folder is trusted like a repository you added">
        Packages from a folder ask for their permissions at install, like any other package, and their updates follow
        the same rules (see <a href="/en/docs/marketplace/updates">Automatic updates</a>). Your organization can turn
        folder sources off or limit them to some folders (see{" "}
        <a href="/en/docs/marketplace/warnings#policy">Warnings and policy</a>).
      </Callout>

      <PageNav />
    </article>
  );
}
