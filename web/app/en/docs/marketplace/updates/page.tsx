import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { MockupFrame } from "@/components/docs/mockup-frame";
import { MessageList } from "@/components/docs/message-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Automatic Updates" };

const cell = "border border-border p-2.5 align-top";

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="Automatic Updates"
        description="Ave checks your sources at start-up and once a day. An update that changes nothing you agreed to installs by itself while no conversation is running; anything else waits for your review and says why."
        tags={["Start-up and daily checks", "Never mid-conversation", "Consent changes wait for you"]}
      />

      <Callout tone="info" title="Applies to Ave 0.14.0 and later">
        Earlier versions lack some of the screens and messages on this page, or show them differently.
      </Callout>

      <h2 id="where">Where to Find It</h2>
      <p>
        <strong>Settings → Marketplace → Maintenance → Updates</strong>. The card shows “Checks for updates at start-up
        and once a day”, when Ave last checked and when it checks next, and <em>Check now</em>. The toolbar shows a pill
        when an update needs you.
      </p>
      <MockupFrame title="Settings → Marketplace → Maintenance">
        <div className="grid gap-2.5 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Updates</span>
            <span className="ml-auto rounded-md border border-border px-2 py-0.5 text-[12px]">Apply now</span>
            <span className="rounded-md border border-border px-2 py-0.5 text-[12px]">Check now</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Update packages automatically</span>
            <span className="h-4 w-7 shrink-0 rounded-full bg-ink" aria-hidden="true" />
          </div>
          <p className="!my-0 text-[12px] text-muted-foreground">
            Checks for updates at start-up and once a day · last checked 3 hours ago · next in 21 hours
          </p>
          <p className="!my-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
            2 updates are waiting for the conversation to pause.
          </p>
          <ul className="!my-0 grid list-none divide-y divide-border rounded-md border border-border !pl-0 text-[12px]">
            <li className="!my-0 grid gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Issue Sync</span>
                  <span className="text-muted-foreground">Extensions · <span className="font-mono">2.0.3 → 2.1.0</span></span>
                </span>
                <span className="text-muted-foreground">Needs your review</span>
                <span className="rounded-md border border-border px-2 py-0.5">Review</span>
                <span className="rounded-md border border-border px-2 py-0.5">Default (On)</span>
              </div>
              <span className="text-muted-foreground">It asks for something different from what you agreed to</span>
            </li>
            <li className="!my-0 grid gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Meeting</span>
                  <span className="text-muted-foreground">Extensions · <span className="font-mono">0.8.4 → 0.9.0</span></span>
                </span>
                <span className="text-muted-foreground">Waiting for the conversation to pause</span>
                <span className="rounded-md border border-border px-2 py-0.5">Default (On)</span>
              </div>
            </li>
          </ul>
        </div>
      </MockupFrame>

      <h2 id="checks">When Ave Checks</h2>
      <ul>
        <li>At start-up and once a day. A source that could not be reached is tried again within the hour; until then its packages show the installed version.</li>
        <li><em>Check now</em> checks at once. A folder source is also read again every few hours and when you choose <em>Refresh</em> on its row.</li>
        <li>
          Offline, the card says “Offline — last checked 3 hours ago. Ave checks again when the network is back.” When only
          some sources answered: “Some sources could not be reached, so their packages show the installed version. Sources
          says why for each; Ave tries them again within the hour.” with <em>Show sources</em>.
        </li>
      </ul>

      <h2 id="automatic">What Updates by Itself</h2>
      <p>An update installs by itself only when all of these hold:</p>
      <ul>
        <li>the package is turned on, its source is shown, and automatic updates are on for it (see <a href="#switches">the switches</a>);</li>
        <li>it is a newer version from the same source, or, for a folder, the same version with changed files;</li>
        <li>it asks for nothing different from what you agreed to at install: the same permissions, network hosts, secrets and sign-in, and every MCP server or hook you approved is unchanged;</li>
        <li>the source&apos;s history was not rewritten, and the version is not one you skipped;</li>
        <li>for an http source, you accepted automatic updates over http for it;</li>
        <li>your organization&apos;s policy still allows its source, and three automatic attempts at that version have not failed.</li>
      </ul>
      <p>
        Updates install one at a time, and only while no conversation turn is running, so nothing changes under a reply
        in progress. Meanwhile the row says “Waiting for the conversation to pause”. After 30 minutes the card says “2
        updates are waiting for the conversation to pause.”, the toolbar pill shows them, and <em>Apply now</em> installs
        them without waiting. A plugin also waits until its running calls finish (“It waits for its running calls to
        finish”).
      </p>
      <p>
        Applied updates are listed under “Updated automatically” for 24 hours, each with <em>What changed</em> (the commit
        range). A package that installed but is not running yet says “Installed, not running — restart Ave”.
      </p>

      <h2 id="review">What Waits for Your Review, and Why</h2>
      <p>Every row says what state it is in and why:</p>
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-secondary text-left">
              <th className={cell}>State</th>
              <th className={cell}>Reasons shown</th>
              <th className={cell}>What you do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={cell}>Needs your review</td>
              <td className={cell}>
                “It asks for something different from what you agreed to” · “What you agreed to could not be read, so confirm
                it once” · “A component approved by an earlier Ave version needs your confirmation”
              </td>
              <td className={cell}><em>Review</em> opens the update review.</td>
            </tr>
            <tr>
              <td className={cell}>Update available</td>
              <td className={cell}>
                “The package is turned off” · “Its source&apos;s history was rewritten and waits for your review” · “It is not a
                newer version from the same source” · “Its source uses http, and automatic updates were not accepted for it” ·
                “Automatic updates are off for it”
              </td>
              <td className={cell}><em>Review</em> installs it with your review.</td>
            </tr>
            <tr>
              <td className={cell}>Update available</td>
              <td className={cell}>“Its source is hidden”</td>
              <td className={cell}>
                First show the source again: turn its switch on in <strong>Sources</strong>. Until then nothing installs from
                it, with or without a review.
              </td>
            </tr>
            <tr>
              <td className={cell}>Update available</td>
              <td className={cell}>“Your organization&apos;s policy no longer allows installs from its source”</td>
              <td className={cell}>
                Nothing installs from that source while the policy stands; ask your administrator to change it. The installed
                version stays.
              </td>
            </tr>
            <tr>
              <td className={cell}>Update failed</td>
              <td className={cell}>“Three automatic attempts failed; Retry installs it with your review” · “Failed attempts at this version: 3”</td>
              <td className={cell}><em>Details</em> shows why; <em>Retry</em> installs it with your review.</td>
            </tr>
            <tr>
              <td className={cell}>Components wait for your approval</td>
              <td className={cell}>Your organization updated a required package whose new or changed components stay off until you approve them.</td>
              <td className={cell}><em>Review</em> opens “Approve components of &lt;name&gt;” for a plugin, or the extension&apos;s settings for an extension.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The update review lists, under “What you agreed to changes”, each permission, host, secret or component that is
        different, as <code>before → after</code>. “A changed or new server or hook runs only once you approve it. Leave
        it unchecked to install the update with it turned off.” When only files that are not code changed, the review is
        one row, “Only these non-code files changed:”, and <em>Approve update</em> accepts it in one step. <em>Keep
        &lt;version&gt;</em> leaves the installed version.
      </p>
      <p>
        A row marked “Source not reached in the last check — shown as an earlier check left it.” is from an earlier check;
        it is brought up to date once its source answers.
      </p>

      <h2 id="switches">The Switches</h2>
      <FeatureGrid
        columns={3}
        items={[
          { title: "Update packages automatically", body: <>The global switch on the Updates card.</>, tone: "teal" },
          { title: "Automatic updates by source", body: <>One select per source on the Updates card.</>, tone: "ink" },
          {
            title: "Automatic updates",
            body: <>One select per package: on its row in the Updates card, and in its package sheet whether or not it has an update.</>,
            tone: "citron",
          },
        ]}
      />
      <p>
        A source or package select offers <em>Default (On)</em> or <em>Default (Off)</em> — what applies when you leave it —
        and <em>On</em> or <em>Off</em>. The first one that is set decides: your organization&apos;s policy, then the
        package, then the source, then the global switch. Left at their defaults, updates are on, except for a source you
        added yourself over http.
      </p>
      <MessageList
        items={[
          {
            tone: "warning",
            label: "Turning on an http source",
            message: (
              <>
                Updates from lab arrive over http. Anyone on the network path could replace them with their own code, and
                it would install without asking. Turn on automatic updates anyway?
              </>
            ),
            fix: <p><em>Turn on anyway</em> accepts this for that source; <em>Cancel</em> leaves it off.</p>,
          },
        ]}
      />

      <h2 id="skip">Skipping a Version</h2>
      <p>
        The toolbar pill offers “Skip until the next update”: the versions it shows are no longer offered, and the next
        newer version is. A skipped version is left out of the card&apos;s list, so after a check with nothing to show
        the card says “No updates to review.” rather than calling everything up to date.
      </p>

      <h2 id="organization">Packages Your Organization Requires</h2>
      <p>
        A package in the policy&apos;s <code>requiredInstalls</code> always updates automatically: the policy stands for
        your consent, so its switch is on and locked (“Required by your organization: it updates automatically, whatever
        this switch is set to.”), and skips, the three-failure stop and the review do not hold it. A revoked or
        incompatible version is still never offered. When such an update brings a plugin component you have not
        approved, the update installs and the component stays off until you approve it in “Approve components of
        &lt;name&gt;”.
      </p>
      <p>
        A policy can also decide automatic updates for everyone with <code>autoUpdate</code>; the global switch is then
        locked with “Set by your organization: packages update automatically.” or “Set by your organization: packages
        update only when you review them.”
      </p>

      <h3 id="unmet">Required, but not installed</h3>
      <p>
        When a required package cannot be installed, the card lists it under “Required by your organization, not
        installed”, with the reason and what you can do:
      </p>
      <MessageList
        items={[
          {
            tone: "warning",
            message: <>Your organization requires docs-search from acme, but that marketplace is not added in Ave.</>,
            fix: <p>Ask your administrator: the policy must also register the marketplace.</p>,
          },
          {
            tone: "warning",
            message: <>Your organization requires docs-search from acme, but that marketplace has not been reached yet.</>,
            fix: <p><em>Refresh source</em> tries again now; check the network or VPN if it keeps failing.</p>,
          },
          {
            tone: "warning",
            message: (
              <>
                Your organization requires docs-search from acme, but that marketplace is hidden, so nothing installs from
                it. Show it again in Sources.
              </>
            ),
            fix: <p><em>Show sources</em> opens Sources; turn the source back on.</p>,
          },
          {
            tone: "warning",
            message: <>Your organization requires docs-search from acme, but that marketplace does not list it.</>,
            fix: <p><em>Refresh source</em> in case it was just published; otherwise tell your administrator.</p>,
          },
          {
            tone: "warning",
            message: <>Your organization requires docs-search from acme, but it needs Ave 0.15.0 or later.</>,
            fix: <p>Update Ave.</p>,
          },
          {
            tone: "warning",
            message: (
              <>
                Your organization requires docs-search from acme, but no release of it is offered to this device yet: its
                releases are held back by a gradual rollout, or are pre-releases. It can install once a release is
                offered to this device.
              </>
            ),
          },
          {
            tone: "warning",
            message: <>Your organization requires docs-search from acme, but that marketplace offers no release of it to this installation.</>,
          },
          {
            tone: "warning",
            message: <>docs-search is installed from team-tools instead; it may stand in the way.</>,
            fix: (
              <p>
                <em>Remove from team-tools…</em> asks first: “Uninstall docs-search, installed from team-tools? It is not the
                one your organization requires. Removing it does not install that one: the requirement stays unmet until
                corp can provide it.”
              </p>
            ),
          },
        ]}
      />
      <p>Rows you cannot act on end with “If this does not resolve itself, contact your administrator.”</p>

      <Callout tone="info" title="When the card itself has a problem">
        “The last check could not finish, so the list may be out of date. Ave tries again within the hour; if this keeps
        happening, restart Ave.” — and if the card cannot load at all: “Update checks are not available right now.
        Restart Ave; if it persists, use Copy details to report it.” A lost update history only resets check times;
        installed packages are unchanged.
      </Callout>

      <PageNav />
    </article>
  );
}
