import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Meeting End → Automatic Tasks" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Event-driven flow"
        title="Meeting End → Action Item Extraction (Not a Routine)"
        description="This flow is handled by an extension that subscribes to the event, not RoutineEngine — when the meeting extension emits meeting.summary.created, the subscribed extension decides whether to surface it and shows the user a card."
        tags={["event-driven", "meeting.summary.created"]}
      />

      <h2 id="flow">One cycle</h2>
      <StepList
        steps={[
          { title: "Meeting end detected", body: <p>The meeting extension emits <code>meeting.ended</code> on user stop / floating window close → the full transcript is saved to SessionStore.</p>, badge: "meeting" },
          { title: "Summary generated", body: <p>The meeting extension summarizes the transcript and extracts <code>actionItems</code> using the host LLM (<code>callLlm</code>). The result is emitted as <code>meeting.summary.created</code>.</p> },
          { title: "Subscribed extension kicks in", body: <p>An extension subscribed to the event evaluates its own policy and then decides whether to surface it.</p> },
          { title: "Proactive card", body: <p>When surfacing is decided, <code>hostApi.triggerConversation</code> shows a card in the chat body. User options are displayed (Tasks / mail / save summary).</p> },
          { title: "Follow-up action", body: <p>Once the user chooses, that extension carries out the actual task using mail/calendar extension tools (e.g. adding a calendar entry, creating a work-board card).</p>, badge: "Final" },
        ]}
      />

      <Callout tone="tip" title="To turn this flow off">
        <ul className="my-1 list-disc pl-5">
          <li><strong>Extension level</strong>: set meeting <code>autoSummarize=false</code> to block the summary itself.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
