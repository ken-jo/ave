import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { MessageList } from "@/components/docs/message-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Marketplace Troubleshooting" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="Marketplace Messages and What to Do"
        description="Every refusal, warning and failure in the marketplace is one sentence that says what happened and what to do. This page lists the ones about addresses, folders, organization policy and updates, word for word, with what to check when the sentence is not enough."
        tags={["Word for word", "By where it appears", "Copy details for reports"]}
      />

      <Callout tone="info" title="Applies to Ave 0.14.0 and later">
        Earlier versions lack some of the screens and messages on this page, or show them differently.
      </Callout>

      <h2 id="reading">Reading a Message</h2>
      <ul>
        <li>
          <strong>Policy</strong> — a lock and “Set by your organization”. Your administrator decided it; the sentence names
          the rule and the policy file. Nothing on this computer can override it.
        </li>
        <li>
          <strong>Warning</strong> — amber. A risk you can accept: <em>Continue</em> in the Add dialog, or <em>Allow…</em>{" "}
          (<em>Allow internal downloads</em>) elsewhere, which states the risk once more before you allow it.
        </li>
        <li>
          <strong>Error</strong> — red. What failed and what to do.
        </li>
      </ul>
      <p>
        <em>Copy details</em> copies the message&apos;s code and Ave&apos;s own English description, with anything that
        looks like a password or token masked. Send that when you report a problem. <em>Copy command</em> appears when a
        command on your computer can fix it.
      </p>

      <h2 id="address">Adding a Source: the Address</h2>
      <MessageList
        items={[
          {
            message: (
              <>
                A relative path cannot be read here: Ave has no current folder to start from. Enter the folder&apos;s full
                path (starting with /, ~ or a drive letter) or use Choose folder…, or enter owner/repo for a GitHub
                repository.
              </>
            ),
          },
          { message: <>A folder has no branch, subfolder or sign-in. Clear them, or enter a git address instead.</> },
          {
            message: (
              <>
                This is a Windows device path, not a folder. Enter the folder&apos;s normal path as File Explorer shows it,
                or a share such as \\server\share\marketplace.
              </>
            ),
          },
          { message: <>This is a Windows path, and this computer does not run Windows. Enter the folder&apos;s path on this computer.</> },
          {
            message: (
              <>
                This file: address names another computer, which Ave does not read on this system. Mount the share and
                enter the folder&apos;s path on this computer.
              </>
            ),
          },
          { message: <>A network path needs a server and a share (\\server\share). Enter the folder&apos;s full network path.</> },
          {
            message: (
              <>
                A network path cannot carry a user name or password. Enter it as \\server\share, and sign in to the share
                through Windows.
              </>
            ),
          },
          { message: <>The path climbs above its drive, share or root with &quot;..&quot;. Enter the folder&apos;s full path without it.</> },
          { message: <>/Users/me/notes.txt is not a folder. Choose a folder.</> },
          { message: <>/Users/me/Marketplace matches several folders that differ only in case. Enter the path with its exact case.</> },
          {
            message: (
              <>
                Ave no longer has the folder you chose (it was replaced by a newer choice, already used, or chosen too
                long ago). Choose the folder again.
              </>
            ),
          },
          {
            message: (
              <>
                The folder dialog could not open. Type the folder&apos;s full path instead; if it persists, use Copy
                details to report it.
              </>
            ),
          },
          {
            message: (
              <>
                The address contains a password or token. Ave never keeps secrets in addresses: remove it from the
                address, then choose Access token under Sign-in and paste the token there.
              </>
            ),
          },
          { message: <>ext:: addresses run a program to fetch, and Ave never runs one. Use the https or ssh address.</> },
          {
            message: (
              <>
                A link cannot choose a folder on this computer, so nothing was filled in. Enter the repository address
                here yourself.
              </>
            ),
            fix: <p>Shown when an <code>ave://marketplace/add</code> link named a path. Use <em>Choose folder…</em> for a folder.</p>,
          },
          { message: <>This id looks like a password or token, so it cannot be used. Choose another id.</> },
          {
            message: <>Git is not installed. Install it under Maintenance, or in the Add dialog.</>,
            fix: <p>A folder needs no git: <em>Choose folder…</em> works without it.</p>,
          },
        ]}
      />
      <p>
        A folder or repository that is already a source, or a folder that overlaps one, is refused with{" "}
        <em>Show &lt;id&gt;</em>; see <a href="/en/docs/marketplace/folders#overlap">Folder sources</a>.
      </p>

      <h2 id="network">Network and Address Checks</h2>
      <MessageList
        items={[
          {
            message: (
              <>
                git.example.com resolves to 169.254.169.254, a link-local or cloud-metadata address. No marketplace lives
                there, and requests to it can expose this computer&apos;s credentials, so Ave does not connect. Check the
                address and your network settings.
              </>
            ),
            fix: (
              <p>
                For a source that worked before, the sentence instead says a VPN, proxy or hosts file on this computer may
                send the host there, and to tell your administrator if it keeps happening.
              </p>
            ),
          },
          { message: <>git.example.com resolves to 240.0.0.1, which cannot be reached from any network. Check the address.</> },
          {
            message: (
              <>
                lab points a download at this computer (localhost). A marketplace may not send requests to services on
                your computer, so nothing was downloaded. Tell the marketplace&apos;s owner.
              </>
            ),
          },
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
                that. Choose Allow… on the source&apos;s row in Sources.
              </>
            ),
          },
          {
            tone: "warning",
            message: (
              <>
                git.lab.example needs sign-in, and this address uses http, so the sign-in would travel unencrypted. Choose
                Check address again and confirm it, with the token under Access token.
              </>
            ),
          },
          { message: <>This computer is offline. Connect to a network, then try again.</> },
          { message: <>Ave could not reach this source. Check the address and your network, then try again.</> },
        ]}
      />

      <h2 id="folders">Folder Sources</h2>
      <p>
        These appear when a folder is added and on its row in Sources. A failed read keeps the contents read last, so
        installed packages keep working.
      </p>
      <MessageList
        items={[
          {
            label: "Folder not found",
            message: (
              <>
                The folder /Volumes/KIT/marketplace does not exist: it was moved or renamed, or its drive is not connected.
                Reconnect the drive, or remove the source and add the folder again.
              </>
            ),
          },
          {
            label: "Folder unreadable",
            message: (
              <>
                /Users/me/Documents/agent-marketplace cannot be read (EACCES). Check the folder&apos;s permissions; Ave
                tries again at the next read.
              </>
            ),
          },
          {
            label: "Folder unreadable",
            message: (
              <>
                /Users/me/CloudSync/ave cannot be read (EIO). A locked file or a cloud file that is not downloaded does
                this; Ave tries again at the next read.
              </>
            ),
            fix: <p>Keep the folder available offline in your sync app, and close programs that lock files in it.</p>,
          },
          {
            label: "Folder unreadable",
            message: (
              <>
                A file in /Users/me/Documents/agent-marketplace changed while Ave read it, so nothing from that read is
                used. Ave tries again at the next read.
              </>
            ),
          },
          {
            label: "Folder moved",
            message: (
              <>
                /Users/me/ave now leads to /Users/me/old-ave, not the folder that was added, so Ave does not read it.
                Remove the source and add the folder you mean.
              </>
            ),
          },
          {
            label: "Folder unreadable",
            message: (
              <>
                /Users/me/Documents/agent-marketplace is no longer the folder that was added: it was replaced or recreated,
                so Ave does not read it. If it holds what you mean, remove the source and add the folder again.
              </>
            ),
          },
          {
            label: "Location unknown",
            message: (
              <>
                Ave cannot tell whether Z:\marketplace is on another computer because its folder classifier is missing or
                broken. Reinstall Ave.
              </>
            ),
          },
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
        ]}
      />
      <p>
        For a folder your organization set up, the sentences end with “Reconnect the drive, or tell your administrator.”
        or “Tell your administrator.”, since only the policy can change it.
      </p>

      <h3 id="folder-contents">What the folder holds</h3>
      <p>These stop an install from a folder; nothing is installed. Fix the folder, then <em>Refresh</em> and install again.</p>
      <MessageList
        items={[
          {
            message: (
              <>
                The folder has no built issue-sync extension (plugin.json and dist/), so nothing was installed. Build the
                extension into dist/, or add its git repository instead.
              </>
            ),
          },
          {
            message: (
              <>
                skills/proofread/notes.md links outside the folder (to ../../shared/notes.md), and Ave installs files from
                inside the folder only. Copy the file into the folder instead of linking it.
              </>
            ),
          },
          {
            message: (
              <>
                skills/proofread/data links to a network location (//files.example/data), and Ave does not follow links to
                other computers. Copy the file into the folder instead of linking it.
              </>
            ),
          },
          {
            message: (
              <>
                skills/proofread/meta links into .git/config, which Ave never reads (version-control data or system
                files). Copy the file into the folder instead of linking it.
              </>
            ),
          },
          { message: <>skills/proofread/pipe is a device, socket or pipe, not a file, so it cannot be installed. Remove skills/proofread/pipe from the folder.</> },
          {
            message: (
              <>
                skills/proofread/Notes.md has the same name as another file once case and accents are ignored, so the
                package cannot be installed on every system. Rename or remove skills/proofread/Notes.md.
              </>
            ),
          },
          { message: <>skills/proofread goes over a package limit (10000 files), so nothing was installed. Remove files from skills/proofread or make them smaller.</> },
        ]}
      />

      <h2 id="policy">Organization Policy</h2>
      <p>
        The policy messages are on <a href="/en/docs/marketplace/warnings#policy">Warnings and policy</a>, with the rule
        each one names. Two more:
      </p>
      <MessageList
        items={[
          {
            tone: "policy",
            message: (
              <>
                The organization&apos;s marketplace policy cannot be read (…), so only the
                official marketplace works. Ask your administrator to fix it.
              </>
            ),
          },
          {
            tone: "policy",
            message: (
              <>
                Your organization requires this package, so it cannot be removed or turned off. Ask your administrator if
                you need it gone.
              </>
            ),
          },
        ]}
      />

      <h2 id="sources">A Source That Needs Repair</h2>
      <MessageList
        items={[
          {
            label: "Downloaded copy damaged",
            message: (
              <>
                This source&apos;s downloaded copy is damaged. In Sources, choose Repair on the source to download it again.
                If its record of the version Ave trusts was lost too, Repair trusts the version the source serves now,
                without checking it against the one you had.
              </>
            ),
          },
          {
            label: "Id looks like a token",
            message: (
              <>
                This source&apos;s id looks like a password or token, so Ave does not sync it or offer its packages. Remove
                the source and add it again with another id.
              </>
            ),
            fix: <p>An earlier Ave let such an id be saved. The row offers only <em>Remove source</em>; your installed packages stay.</p>,
          },
          {
            message: (
              <>
                Ave cannot read the list of sources you added, marketplaces/sources.json in the Ave data folder, so it
                changes no source until the file is fixed. Fix the file or delete it, then restart Ave. Deleting it
                removes only the sources you added: the official and organization sources and your installed packages
                stay.
              </>
            ),
          },
        ]}
      />

      <h2 id="reviews">Reviews and Updates</h2>
      <MessageList
        items={[
          {
            message: (
              <>
                What you reviewed is no longer valid: it expired after 10 minutes, or a newer review replaced it. Start
                again to review it fresh.
              </>
            ),
          },
          {
            message: <>Your organization&apos;s policy changed while you were reviewing. Start again to review it under the new policy.</>,
            fix: <p><em>Review again</em> opens a new review under the new policy.</p>,
          },
          { message: <>This package changed since you reviewed it. Review it again.</> },
          {
            message: (
              <>
                The last check could not finish, so the list may be out of date. Ave tries again within the hour; if this
                keeps happening, restart Ave.
              </>
            ),
          },
          {
            message: <>Update checks are not available right now. Restart Ave; if it persists, use Copy details to report it.</>,
          },
          {
            tone: "warning",
            message: (
              <>
                Ave could not read its update history (marketplaces/updates.json in the Ave data folder) and started a
                new one. Only the check times were lost; your installed packages are unchanged.
              </>
            ),
          },
        ]}
      />
      <p>
        Why an update waits, and the rows for required packages, are on{" "}
        <a href="/en/docs/marketplace/updates#review">Automatic updates</a>.
      </p>

      <Callout tone="info" title="Still stuck?">
        Use <em>Copy details</em> on the message and send it with what you were doing to the marketplace&apos;s owner, or
        to your administrator for an organization source or a policy message.
      </Callout>

      <PageNav />
    </article>
  );
}
