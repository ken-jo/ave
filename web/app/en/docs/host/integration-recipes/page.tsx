import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Integration Recipes — Extension Combination Scenarios" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Integration Recipes"
        title="A Collection of Extension Combination Scenarios"
        description="What matters more than using a single extension is the 'chain' where several extensions work together. This page lays out three commonly used combination scenarios as short flows. Every chain goes through a user consent card, and any step that runs automatically is marked explicitly."
        tags={["Meeting + mail & calendar", "Local Indexer + work board", "Meeting + work board"]}
      />

      <h2 id="recipe-1">Recipe 1 — Meeting → Action → Schedule → Reply</h2>
      <p>The most frequent chain. Decisions made in a meeting flow naturally into a schedule entry and a reply.</p>
      <StepList
        steps={[
          { title: "Meeting ends", body: <p>The <strong>Meeting</strong> extension ends the recording → automatically extracts meeting notes and candidate action items.</p>, badge: "Meeting" },
          { title: "Follow-up card appears", body: <p>A subscribed extension surfaces the action item candidates as a user confirmation card. Choose from "add as a task / reply by mail / add to schedule."</p>, badge: "Confirmation card" },
          { title: "Schedule entry + reply draft", body: <p>If the user picks "schedule + reply" → the event is added to the <strong>mail &amp; calendar extension</strong> calendar, and a reply draft appears in chat. It is only actually sent the moment "Send" is pressed.</p>, badge: "Mail & calendar" },
          { title: "Records preserved", body: <p>Every step is logged in the audit trail, and extracted action items are also synced as work-board cards.</p> },
        ]}
      />

      <h2 id="recipe-2">Recipe 2 — From "Where was that file?" to a Presentation Slide</h2>
      <p>The Local Indexer is the core here — one flow from search, to path lookup, to content summary, to a presentation-ready reformat.</p>
      <StepList
        steps={[
          { title: "Natural language search", body: <p>Ask in chat, "where was the material about OOO?" → <strong>Local Indexer</strong> answers with candidate files and its reasoning.</p>, badge: "Local Indexer" },
          { title: "Path lookup", body: <p>Ask for the "exact file path" → the absolute path (including NAS mounts) is printed as-is. Open it directly from the OS file manager.</p> },
          { title: "Summarize + reformat", body: <p>On the same file, ask to "format this into one slide for a presentation" → the host LLM reuses the same match result and reformats it for a presentation.</p>, badge: "Reused" },
          { title: "Send to a work-board card", body: <p>Register the summary as a "prepare presentation material" card on the <strong>work board</strong> built into the app.</p>, badge: "work board" },
        ]}
      />

      <h2 id="recipe-3">Recipe 3 — Video Call → Automatic Meeting Notes → Team Board</h2>
      <p>Wrapping up a meeting with external attendees. Notes, action items, and team sharing, all in one pass.</p>
      <StepList
        steps={[
          { title: "Automatic meeting notes", body: <p>During the meeting, the <strong>Meeting</strong> extension runs live transcription. On end, it automatically generates notes, a summary, and action items.</p>, badge: "Meeting" },
          { title: "Moved onto the work board", body: <p>Action items are registered as cards on the <strong>work board</strong> built into the app. Cards nearing their deadline are sent as notifications.</p>, badge: "work board" },
          { title: "Notes stay in their own area", body: <p>The original meeting notes are kept only inside the Meeting extension's own area. They are not automatically sent to an external server.</p>, badge: "Only on your PC" },
        ]}
      />

      <Callout tone="info" title="Make a recipe your own">
        Each recipe can be registered as an "automation rule." When a trigger arrives — a meeting ending, new mail arriving, a specific time — the host fires the same flow automatically, and the user only needs to check the resulting card.
      </Callout>

      <Callout tone="security" title="Every chain goes through a consent card">
        Separately from the word "automation," risky steps (sending mail, calling external services, submitting an approval) always go through a consent card.
        Being registered under automation once does not mean risky steps afterward are handled without asking.
      </Callout>

      <PageNav />
    </article>
  );
}
