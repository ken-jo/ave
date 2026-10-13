import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { FolderOpen, Search, Cpu } from "lucide-react";

export const metadata = { title: "Local Indexer Extension" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Extension · Local Indexer"
        title="Local Indexer — search your own PC's files from inside Ave"
        description="Automatically analyzes documents in folders you designate and turns them into search context you can cite right in Ave chat. Optimized for Korean documents, PDFs, and Markdown."
        tags={["Local RAG", "Korean-optimized", "auto sync"]}
      />

      <FeatureGrid
        columns={3}
        items={[
          {
            icon: <FolderOpen className="h-5 w-5" />,
            title: "Automatic per-folder watching",
            body: <>The index refreshes automatically whenever a file is added, modified, or removed in a designated folder. No heavy polling, so it stays quiet.</>,
            tone: "teal",
          },
          {
            icon: <Cpu className="h-5 w-5" />,
            title: "Optimized for Korean documents",
            body: <>Runs Korean morphological analysis and breaks content into small chunks so even short keywords match well. Supports both PDF and Markdown.</>,
          },
          {
            icon: <Search className="h-5 w-5" />,
            title: "Multiple search results combined",
            body: <>Combines keyword search and semantic search to surface the best candidates — a multi-stage combination, not a single match.</>,
            tone: "citron",
          },
        ]}
      />

      <h2 id="add-folder">Adding a folder</h2>
      <StepList
        steps={[
          { title: "Choose a folder", body: <p>Pick the folder to index from the OS's file picker dialog.</p> },
          { title: "Preview", body: <p>Shows the file count for the folder and an estimated analysis time up front.</p> },
          { title: "Add", body: <p>Pressing "Add" starts the initial analysis in the background, and any later changes inside the folder are reflected automatically.</p>, badge: "auto watch" },
        ]}
      />

      <h2 id="scenario">Real-world scenario — from "where did I save that?" to a presentation slide</h2>
      <p>
        Local Indexer's real value isn't a one-off search — it comes from the chain of <strong>find → confirm path → clean up content → convert format</strong>.
      </p>
      <StepList
        steps={[
          { title: "Find a file by keyword", body: <p>A natural-language query like "where were the materials on the detection step?" returns the best-matching file candidates along with the evidence.</p>, badge: "find" },
          { title: "Confirm the exact path", body: <p>The full absolute path, including UNC paths, is printed as-is so you can open it directly from the OS file manager.</p>, badge: "path" },
          { title: "Auto-summarize content", body: <p>Pulls out just the key content of the same file. Reuses the same match results without re-searching, so it's fast and consistent.</p>, badge: "summary" },
          { title: "Reformat into a single presentation slide", body: <p>Reorganizes the same content into a one-page presentation format.</p>, badge: "convert" },
        ]}
      />

      <Callout tone="security" title="Your data stays on your PC">
        All indexes, embeddings, and caches are kept on the user's own PC. Nothing is sent to an external server.
      </Callout>

      <PageNav />
    </article>
  );
}
