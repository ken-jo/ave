import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Extension Permission Grant Flow" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Extensions"
        title="Permission grant flow"
        description="When an extension is activated for the first time, a single unified dialog shows the user every permission element declared in its manifest (capabilities · tools categories · pluginAccess · hostSecrets · agentApprovalScopes) at once."
      />

      <h2 id="what">Items reviewed from the manifest</h2>
      <ul>
        <li><strong>capabilities</strong>: format-validated capability tags. The host's runtime enforcement set holds <strong>exactly two ids</strong>, and a string outside that set does not open one of those two gates. But "not a gate" is not the same as "no effect" — there are places where the host uses one of these strings as a <em>lookup key</em> to find which extension fills a role, so a single declaration can be what wires that role's whole tool surface to that extension.</li>
        <li><strong>tools[]</strong>: pure MCP <code>Tool</code> objects. The Host classifies risk from each input schema and execution path; the operation policy the manifest declares may only raise the minimum risk or require read-before-write.</li>
        <li><strong>pluginAccess</strong>: which other extension's tools/events this extension will use (e.g. one extension calling a calendar extension's <code>calendar_today</code>).</li>
        <li><strong>agentApprovalScopes</strong>: standard labels for cross-extension risky actions (e.g. <code>agent_file_share</code>, <code>agent_task_delegate</code>, <code>agent_external_api_call</code>).</li>
        <li><strong>hostSecrets / llmKeySource</strong>: secret access / LLM key vendor declarations.</li>
        <li><strong>configSchema</strong>: user-editable config fields + defaults.</li>
      </ul>

      <h2 id="flow">What the user sees</h2>
      <StepList
        steps={[
          { title: "Install from the Marketplace", body: <p>Press &quot;Install&quot; in Settings → Marketplace. An <code>ave://install/plugin/&lt;name&gt;@&lt;source&gt;</code> link opens the same screen (<code>src/main/ave-protocol.ts</code>).</p> },
          { title: "Artifact check", body: <p>The artifact the source&apos;s snapshot pins is checked against its SHA-256 or commit, and the authority fields in <code>plugin.json</code> must equal the marketplace descriptor&apos;s. A mismatch stops the install (<code>src/marketplace/resolve/</code>).</p>, badge: "pin" },
          { title: "Permission dialog — everything at once", body: <p>The parsed manifest is grouped by category — capabilities / tools / pluginAccess / secrets — and shown together. The grant is saved once the user confirms.</p> },
          { title: "First activation", body: <p>Its own namespace <code>{"~/.ave/plugins/<pluginId>/"}</code> is created (0o700). The validated Skills, Hooks, and MCP servers are activated atomically with the extension runtime.</p>, badge: "start()" },
        ]}
      />

      <Callout tone="warn" title="Behavior after revoking a permission">
        Even after installation, a grant can be revoked from Host Settings → Extensions → the extension → Permission Management.
        Once revoked, an incoming tool call is rejected immediately with no fallback, and a re-grant card is fired (Ave's no-fallback rule).
      </Callout>

      <PageNav />
    </article>
  );
}
