import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Permissions — Directory" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Permissions"
        title="Directory / File Permissions"
        description="Whenever Ave touches files on your PC, it only ever operates within folders you've explicitly allowed. Permissions are granted per folder, and you decide the scope and duration yourself."
      />

      <h2 id="plugin-sandbox">Extensions can freely use only their own domain</h2>
      <p>
        Each extension can freely read and write only within the domain the host has carved out for it. It can never access another extension's domain,
        and it can only enter external folders such as your home directory after receiving your explicit permission.
      </p>

      <h2 id="host-grant">When the host needs to access an external folder</h2>
      <StepList
        steps={[
          { title: "Request trigger", body: <p>A built-in host tool or an external tool attempts to write to an external area such as your home folder → a permission card fires.</p> },
          { title: "Permission card", body: <p>Choose read-only / read+write, plus scope (this folder only / include subfolders) and duration (1 hour / 24 hours / permanent).</p> },
          { title: "Permission persistence", body: <p>Granted permissions are recorded in the Ave area on your PC, preserving who granted it, when, and with what scope.</p>, badge: "audit trail" },
          { title: "Usage", body: <p>Subsequent calls to the same tool run automatically within the granted permission. Access outside the scope is rejected immediately with no bypass, and re-authorization is requested from you.</p> },
        ]}
      />

      <Callout tone="security" title="Two safety layers">
        An extension tool must pass both (1) its own domain sandbox and (2) permission review before it can run.
        Built-in host tools and external MCP tools only go through step (2), so permission review is more conservative for them.
      </Callout>

      <PageNav />
    </article>
  );
}
