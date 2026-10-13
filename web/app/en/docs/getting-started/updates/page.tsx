import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "App Updates" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Getting Started"
        title="App Updates"
        description="Ave periodically checks in the background for new versions. Nothing is downloaded or force-installed without your consent."
        tags={["No auto-download", "You choose to restart", "Rollback available"]}
      />

      <h2 id="how">How updates are applied</h2>
      <ul>
        <li>The host only checks for a new version at regular intervals.</li>
        <li>Even when a new version is detected, it is not downloaded automatically.</li>
        <li>Once the download completes, a "Restart to update" card appears at the top of the chat area.</li>
        <li>The new build is applied only the moment you click "Restart."</li>
      </ul>

      <Callout tone="info" title="Rollback">
        If something goes wrong after an update, the host guides you through reverting to the previous version.
        Packages are separate: a marketplace&apos;s operator can yank a bad version or list it for revocation, which disables or uninstalls it wherever it was installed from that source.
      </Callout>

      <PageNav />
    </article>
  );
}
