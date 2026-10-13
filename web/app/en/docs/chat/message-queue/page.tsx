import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Message Queue & Tasks" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="Message Queue & Tasks Panels"
        description="Two panels stacked directly above the composer — SessionTasksPanel (session tasks) and MessageQueuePanel (pending external signals). Both are rendered by ChatComposerDock, and each draws nothing when it has no items."
        tags={[
          "rendered by ChatComposerDock",
          "MessageQueuePanel + SessionTasksPanel",
          "hidden when empty",
        ]}
      />

      <h2 id="queue">MessageQueuePanel</h2>
      <p>
        When an external signal arrives (a new Outlook email, a meeting ending, etc.), it stacks up as a card in the panel without blocking the ChatView body.
        Implementation: <code>src/ui/renderer/components/MessageQueuePanel.tsx</code>. Clicking a card switches the chat body to an ask-user question card or a tool call.
      </p>

      <h2 id="tasks">SessionTasksPanel</h2>
      <p>
        Session-scoped tasks. Items added directly by the user and items created by the agent from context share the same list.
        Implementation: <code>src/ui/renderer/components/SessionTasksPanel.tsx</code>. Each item is shown with a source label.
      </p>

      <h2 id="dispatch">How a signal reaches the panel</h2>
      <ol>
        <li>A mail extension calls <code>hostApi.emitEvent('email.new', payload)</code>.</li>
        <li>A subscribed extension evaluates it in <code>onEvent('email.new', …)</code>.</li>
        <li>When the detector decides on a surface, it calls <code>hostApi.triggerConversation({"{ …spec }"})</code>.</li>
        <li>The host UI exposes it via the MessageQueuePanel or a card.</li>
        <li>Every flow appends one line to <code>{"~/.ave/audit/<YYYY-MM-DD>.jsonl"}</code>.</li>
      </ol>

      <Callout tone="info" title="There's no API like enqueueMessage">
        The HostApi contract has no <code>hostApi.enqueueMessage</code> method.
        The standard path for putting an item on the panel is <strong>emit an event → host UI detects it → render</strong>, or
        <strong> triggerConversation</strong>.
      </Callout>

      <PageNav />
    </article>
  );
}
