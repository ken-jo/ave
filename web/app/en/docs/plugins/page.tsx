import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { Badge } from "@/components/ui/badge";

const plugins = [
  { slug: "local-indexer", title: "Local Indexer", id: "local-indexer", ver: "0.6.6", scope: "Local · RAG", desc: "kiwipiepy Korean morphological analysis + pymupdf4llm + FTS5 + LanceDB. Folder watching via chokidar.", color: "from-teal/10 to-transparent" },
  { slug: "meeting", title: "Meeting", id: "meeting", ver: "0.8.4", scope: "Audio · STT", desc: "OpenAI Whisper API (gpt-4o-transcribe) + PCM16LE 16kHz/3sec chunks.", color: "from-coral/10 to-transparent" },
];

export const metadata = { title: "Extensions — Overview" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Extensions"
        title="Extensions — the unit for adding what the host doesn't know about"
        description="Every domain feature in Ave (mail, calendar, meetings, documents, corporate APIs) is split out into extensions. The host core never imports extension-specific code. Extensions vendor the public contract at an app release tag."
        tags={["static manifest", "app release contract"]}
      />

      <Callout tone="info" title="Extension registration model — static manifest">
        Tools, Skills, Hooks, MCP servers, events, and UI slots are all declared statically in the <code>plugin.json</code> manifest.
        There is no runtime registration API like <code>registerTool</code>/<code>registerSkill</code>/<code>registerCommand</code>.
        Skills provide instructions; only pure manifest <code>Tool</code> objects are callable.
      </Callout>

      <div className="my-8 grid gap-3 sm:grid-cols-2">
        {plugins.map((p) => (
          <Link
            key={p.slug}
            href={`/en/docs/plugins/${p.slug}`}
            className="group relative overflow-hidden rounded-2xl border border-border bg-white p-5 transition hover:-translate-y-0.5 hover:border-ink/15 hover:shadow-md"
          >
            <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${p.color}`} />
            <div className="relative">
              <div className="mb-1.5 flex items-center justify-between">
                <Badge variant="muted">{p.scope}</Badge>
                <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-ink" />
              </div>
              <p className="text-[16px] font-semibold text-ink">{p.title}</p>
              <p className="mt-0.5 text-[11.5px] font-mono text-muted-foreground">id: {p.id} · v{p.ver}</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{p.desc}</p>
            </div>
          </Link>
        ))}
      </div>

      <h2 id="install">Install flow</h2>
      <ol>
        <li>Pick an extension in Settings → Marketplace → &quot;Install&quot; (an <code>ave://install/plugin/&lt;name&gt;@&lt;source&gt;</code> link opens the same screen).</li>
        <li>The host fetches the artifact the source&apos;s snapshot pins, checks it against the pinned SHA-256 or commit, and checks that <code>plugin.json</code> matches the marketplace&apos;s descriptor.</li>
        <li>The install receipt records a hash per file, checked again on every launch.</li>
        <li>An extension permission dialog appears → user confirms → its own namespace <code>{"~/.ave/plugins/<pluginId>/"}</code> is created.</li>
        <li>The validated declarative bundle is activated as one unit and the extension's <code>start()</code> callback is called.</li>
      </ol>

      <Callout tone="info" title="Past → present consolidation history">
        <ul className="my-1 list-disc pl-5">
          <li>The <strong>agent-hub</strong> sidebar extension was archived (2026-06-15) and its work board was folded into the personal kanban board built into the app. It is no longer an installable extension.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
