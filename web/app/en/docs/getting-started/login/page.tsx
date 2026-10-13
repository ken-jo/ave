import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Login & First Screen" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Getting Started"
        title="Login & First Screen"
        description="The Ave host app has no Ave account. The Marketplace needs no sign-in either; signing in is handled by each extension that uses an external service, such as Microsoft 365. Auth windows open through hostApi.openAuthWindow / hostApi.openAuthPartitionViewer on the extension side."
      />

      <h2 id="why">What do I sign in to?</h2>
      <ul>
        <li><strong>Marketplace</strong> — no sign-in. The app reads git repositories directly. A private repository is read with an access token set through <strong>Set token</strong> in Settings → Marketplace → Sources, or with this computer&apos;s git credential helper.</li>
        <li><strong>External-service extensions</strong> — each extension&apos;s own OAuth. Tokens are isolated to the extension namespace.</li>
      </ul>

      <h2 id="flow">Login flow</h2>
      <StepList
        steps={[
          { title: "Install the extension", body: <p>Install the extension from Settings → Marketplace. You review the install plan and install without any account.</p> },
          { title: "Extension OAuth — when needed", body: <p>Sign-in for external-service extensions is handled separately via <code>hostApi.openAuthWindow</code> on first use after extension install.</p> },
          { title: "Token storage", body: <p>Tokens an extension receives and marketplace access tokens are stored encrypted in the operating system&apos;s secure storage.</p>, badge: "safeStorage" },
        ]}
      />

      <h2 id="first-screen">First screen — what does it look like?</h2>

      <Callout tone="tip" title="What works without logging in">
        The host chat, Marketplace installs and local extensions (e.g. Local Indexer's pre-indexed folders) work without logging in.
        Only extension tools that reach an external service ask for that service&apos;s sign-in.
      </Callout>

      <PageNav />
    </article>
  );
}
