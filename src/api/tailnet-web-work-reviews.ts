import { DEFAULT_LOCALE, normalizeLocale, SUPPORTED_LOCALES, type Locale } from "../i18n/locale.js";
import { loadLocaleMessages } from "../i18n/messages/index.js";

const REVIEW_MESSAGE_KEYS = new Set([
  "common.cancel",
  "routinePanel.cronSchedule",
  "routinePanel.repeatLabel",
  "routinePanel.repeatNone",
  "routinePanel.repeatDaily",
  "routinePanel.repeatWeekly",
  "routinePanel.repeatMonthly",
  "routinePanel.repeatInterval",
  "workApprovals.planAgentHeading",
  "workApprovals.planFactNoProject",
  "workApprovals.planFactPlannedAt",
  "workApprovals.planFactProject",
  "workApprovals.planFactRevisions",
  "workApprovals.planFactRevisionsValue",
  "workApprovals.planFactTools",
  "workApprovals.planFactToolsValue",
  "workApprovals.planFactExactPlan",
  "workBoard.detailFieldLabel",
  "workBoard.planDecisionStale",
  "workflowTemplates.allProjects",
  "workflowTemplates.allTools",
  "workflowTemplates.approveStage",
  "workflowTemplates.changeNote",
  "workflowTemplates.commands",
  "workflowTemplates.confirmationDescription",
  "workflowTemplates.createAndRun",
  "workflowTemplates.declaredTools",
  "workflowTemplates.goal",
  "workflowTemplates.graphDetails",
  "workflowTemplates.graphHash",
  "workflowTemplates.humanGate",
  "workflowTemplates.joinConflict",
  "workflowTemplates.keepsInputsLocal",
  "workflowTemplates.modelGate",
  "workflowTemplates.networkHosts",
  "workflowTemplates.noDataSentFlag",
  "workflowTemplates.noProject",
  "workflowTemplates.readRoots",
  "workflowTemplates.projectMismatch",
  "workflowTemplates.readTools",
  "workflowTemplates.rejectJoin",
  "workflowTemplates.rejectStage",
  "workflowTemplates.requestChanges",
  "workflowTemplates.requestedOutputs",
  "workflowTemplates.retryJoin",
  "workflowTemplates.reviewVersion",
  "workflowTemplates.runDescription",
  "workflowTemplates.scope",
  "workflowTemplates.sendsToService",
  "workflowTemplates.setupCommands",
  "workflowTemplates.stageGraph",
  "workflowTemplates.stageGate",
  "workflowTemplates.stageResult",
  "workflowTemplates.staleDraft",
  "workflowTemplates.subAgents",
  "workflowTemplates.subAgentsAllowed",
  "workflowTemplates.subAgentsDisabled",
  "workflowTemplates.successGate",
  "workflowTemplates.versionPins",
  "workflowTemplates.workTitle",
  "workflowTemplates.writePaths",
]);

export function tailnetWebLocale(acceptLanguage: string | undefined): Locale {
  let locale: Locale = DEFAULT_LOCALE;
  let best = 0;
  for (const entry of acceptLanguage?.split(",") ?? []) {
    const [tag = "", weight] = entry.trim().toLowerCase().split(/\s*;\s*/, 2);
    const primary = tag.split("-", 1)[0];
    if (!SUPPORTED_LOCALES.some(supported => supported === primary)) continue;
    const quality = weight === undefined ? 1 : weight.startsWith("q=") ? Number(weight.slice(2)) : 0;
    if (quality > best && quality <= 1) {
      locale = normalizeLocale(tag);
      best = quality;
    }
  }
  return locale;
}

export async function loadTailnetWebMessages(locale: Locale): Promise<Record<string, string>> {
  const messages = await loadLocaleMessages(locale);
  return Object.fromEntries(Object.entries(messages).filter(([key]) => REVIEW_MESSAGE_KEYS.has(key)
    || key.startsWith("tailnetWorkReviews.") || key.startsWith("reasonCodes.")
    || key.startsWith("workflowSchedule.") || key.startsWith("workflowTemplates.joinReason.")
    || key === "toolApprovalDialog.allowOnce" || key === "toolApprovalDialog.decisionDeny"));
}

export const TAILNET_WORK_REVIEW_STYLE = `
  #work-reviews { margin-block: 1.25rem; min-inline-size: 0; overflow-wrap: anywhere; }
  #work-reviews > header { flex-wrap: wrap; gap: .5rem; }
  #work-reviews h2 { margin: 0; }
  #work-review-list { display: grid; gap: .75rem; }
  .work-review-card { min-inline-size: 0; border: 1px solid var(--line); border-radius: .75rem; background: var(--panel); }
  .work-review-card > summary { padding: .85rem; min-block-size: 44px; box-sizing: border-box; cursor: pointer; }
  .work-review-card > summary span { display: block; margin-block-start: .3rem; }
  .work-review-body { padding: 0 .85rem .85rem; }
  .work-review-body h4 { margin-block: .75rem .35rem; }
  .work-review-body details { margin-block: .5rem; }
  .work-review-body details > summary { cursor: pointer; padding-block: .35rem; }
  .work-review-body dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: .3rem .7rem; }
  .work-review-body dt { color: var(--muted); }
  .work-review-body dd { margin: 0; min-inline-size: 0; white-space: pre-wrap; }
  .work-review-body pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface); padding: .6rem; border-radius: .4rem; }
  #output-execution-cards { display: grid; gap: .75rem; margin-block: .75rem; }
  #output-execution-cards .work-review-card { padding: .85rem; }
  #output-execution-cards pre { max-block-size: min(45vh, 25rem); overflow: auto; }
  #output-retries .work-review-card { padding: .85rem; margin-block: .75rem; }
  .work-review-body label { display: grid; gap: .25rem; margin-block: .65rem; }
  .work-review-body :is(input, select, textarea) { box-sizing: border-box; inline-size: 100%; min-inline-size: 0; color: inherit; }
  .work-review-body textarea { min-block-size: 4rem; }
  .work-review-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-block-start: .8rem; }
  #work-reviews button { min-block-size: 44px; padding: .45rem .7rem; }
  #work-reviews button[data-work-action="approve"]:enabled { background: var(--accent); color: var(--on-accent); border-color: transparent; }
  .work-review-recent-entry { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-block: .5rem; }
  .work-review-recent-entry p { margin: 0; }
  :is(#work-review-feedback, .work-review-feedback):empty { margin: 0; }
  :is(#work-review-feedback, .work-review-feedback)[data-error] { color: var(--danger); }
  @media (max-width: 30rem) {
    .work-review-actions > button { flex: 1 1 auto; }
    .work-review-body dl { grid-template-columns: minmax(0, 1fr); }
    .work-review-body dd { margin-block-end: .25rem; }
  }
`;

// This script runs inside the document's existing nonce block; it has no external imports.
export const TAILNET_WORK_REVIEW_SCRIPT = String.raw`
  const message = (key, args = {}) => {
    const text = boot.messages[key];
    if (typeof text !== "string") throw new Error("Missing Web message: " + key);
    return text.replace(/\{([a-zA-Z]+)\}/g, (token, name) => Object.hasOwn(args, name) ? args[name] : token);
  };
  const workText = (key, args) => message("tailnetWorkReviews." + key, args);
  function workReviewUi() {
    const section = document.getElementById("work-reviews");
    const list = document.getElementById("work-review-list");
    const feedback = document.getElementById("work-review-feedback");
    const empty = document.getElementById("work-review-empty");
    const reload = document.getElementById("work-review-refresh");
    const recentHeading = document.getElementById("work-review-recent-heading");
    const recentResults = document.getElementById("work-review-recent-results");
    const outputList = document.getElementById("output-execution-cards");
    const executionCards = new Map();
    const retryList = document.getElementById("output-retries");
    const retries = new Map();
    const states = new Map();
    const submissions = new Map();
    let submissionOrder = 0;
    let reviews = new Map();
    let scope;
    let revoked = false;
    let latestSnapshot;
    reload.addEventListener("click", () => scheduleRefresh(false, 0));

    function reveal(value) {
      return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Default_Ignorable_Code_Point}/gu,
        character => "⟨U+" + character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0") + "⟩");
    }
    function element(tag, text) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = reveal(text);
      return node;
    }
    function facts(parent, rows) {
      const dl = element("dl");
      for (const [label, value] of rows) {
        if (value !== undefined) dl.append(element("dt", label), element("dd", value));
      }
      if (dl.childElementCount) parent.append(dl);
    }
    function evidence(parent, label, value) {
      if (value === undefined) return;
      parent.append(element("h4", label), element("pre", value));
    }
    function updateExecutionCards(snapshot) {
      if (!outputList) return;
      const visible = new Set();
      for (const card of snapshot.outputCards ?? []) {
        const id = card.requestId;
        let held = executionCards.get(id);
        if (!card.content) {
          if (!held) continue;
          visible.add(id);
          const text = card.resolvedBy === "expired" ? workText("outputApprovalExpired")
            : workText("outputResolvedBy", { surface: workText(card.resolvedBy === "desk" ? "desktopSurface" : "phoneSurface") });
          held.node.replaceChildren(held.title, element("p", text));
          held.handle = undefined;
          continue;
        }
        visible.add(id);
        if (held) { held.handle = card.handle; continue; }
        const { toolName, ownerId, argsText, target, canonicalTarget, serviceEndpoint } = card.content;
        const node = element("article");
        node.className = "work-review-card work-review-body";
        const title = element("h3", toolName);
        node.append(title);
        facts(node, [[workText("outputOwner"), ownerId], [workText("outputServiceEndpoint"), serviceEndpoint], [workText("outputTarget"), target ?? workText("outputTargetUnknown")],
          [workText("outputCanonicalTarget"), canonicalTarget]]);
        const args = element("pre");
        args.textContent = argsText;
        args.tabIndex = 0;
        args.setAttribute("aria-label", workText("arguments"));
        node.append(element("h4", workText("arguments")), args);
        const actions = element("div");
        actions.className = "work-review-actions";
        const status = element("p");
        status.setAttribute("role", "status");
        const controls = [];
        held = { node, title, handle: card.handle };
        for (const [choice, label] of [["allow-once", "toolApprovalDialog.allowOnce"], ["deny-once", "toolApprovalDialog.decisionDeny"]]) {
          const button = element("button", message(label));
          button.type = "button";
          button.dataset.workAction = choice === "allow-once" ? "approve" : "deny";
          button.addEventListener("click", async () => {
            if (!held.handle || button.disabled || revoked || scope !== snapshot.scope || !node.isConnected) return;
            for (const control of controls) control.disabled = true;
            status.textContent = workText("submitting");
            try {
              const response = await request(boot.workDecisionPath, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: crypto.randomUUID(), scope, kind: "output-execution-card", input: { handle: held.handle, choice } }),
              });
              const result = await response.json();
              status.textContent = response.ok && result.ok ? workText("submitted") : refusal(result.error);
            } catch { status.textContent = workText("submissionUnknown"); }
            finally { scheduleRefresh(false, 0); }
          });
          controls.push(button);
          actions.append(button);
        }
        node.append(actions, status);
        executionCards.set(id, held);
        outputList.append(node);
      }
      for (const [id, held] of executionCards) {
        if (visible.has(id)) continue;
        held.node.remove();
        executionCards.delete(id);
      }
    }
    function updateRetries(snapshot) {
      if (!retryList) return;
      const visible = new Set();
      for (const retry of snapshot.outputRetries ?? []) {
        const { itemId, input, summary, detail, refusal: blocked } = retry;
        const key = JSON.stringify([itemId, input, summary, detail, blocked]);
        visible.add(key);
        if (retries.has(key)) continue;
        const node = element("article");
        node.className = "work-review-card";
        node.append(element("h3", summary));
        if (detail) node.append(element("p", refusal(detail)));
        if (blocked) node.append(element("p", refusal(blocked)));
        else {
          const button = element("button", workText("outputRetry"));
          button.type = "button";
          const status = element("p");
          status.setAttribute("role", "status");
          button.addEventListener("click", async () => {
            if (button.disabled || revoked || scope !== snapshot.scope || !node.isConnected) return;
            button.disabled = true;
            status.textContent = workText("submitting");
            try {
              const response = await request(boot.workDecisionPath, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: crypto.randomUUID(), scope, kind: "output-retry", itemId, input }),
              });
              const result = await response.json();
              status.textContent = response.ok && result.ok ? workText("outputRetryAccepted") : refusal(result.error);
              if (!response.ok || !result.ok) button.disabled = false;
            } catch { status.textContent = workText("submissionUnknown"); }
            finally { scheduleRefresh(false, 0); }
          });
          node.append(button, status);
        }
        retries.set(key, node);
        retryList.append(node);
      }
      for (const [key, node] of retries) {
        if (visible.has(key)) continue;
        node.remove();
        retries.delete(key);
      }
    }
    function detail(parent, label) {
      const details = element("details");
      details.append(element("summary", label));
      parent.append(details);
      return details;
    }
    function field(parent, label, input) {
      const group = element("label", label);
      group.append(input);
      parent.append(group);
      return input;
    }
    function input(type, value = "") {
      const node = element("input");
      node.type = type;
      node.value = value;
      return node;
    }
    function project(scope) {
      return scope.kind === "project" ? scope.projectRoot : message("workflowTemplates.allProjects");
    }
    function pinRows(pin) {
      return [
        [workText("templateId"), pin.templateId],
        [workText("version"), pin.version],
        [message("workflowTemplates.graphHash"), pin.graphHash],
      ];
    }
    function bindingRows(item) {
      const binding = item.binding.input;
      return [
        [workText("itemId"), item.binding.itemId ?? binding.itemId],
        [workText("runId"), binding.runId],
        [workText("stageId"), binding.stageId],
        [workText("attempt"), binding.attempt],
        [workText("planHash"), binding.planHash],
        [workText("resultHash"), binding.resultHash],
        [workText("outputHash"), binding.outputHash],
        [workText("joinId"), binding.joinId],
        [workText("generation"), binding.generation],
        [workText("conflictHash"), binding.conflictHash],
        [message("workflowSchedule.template"), item.kind === "schedule-attachment" ? item.review.name : undefined],
        [workText("templateId"), item.binding.templateId ?? binding.templateId],
        [workText("draftRevision"), binding.expectedDraftRevision],
        [workText("version"), binding.version],
        [message("workflowTemplates.graphHash"), binding.graphHash ?? binding.expectedGraphHash],
        [workText("scheduleId"), binding.scheduleId],
      ];
    }
    function stageCapabilities(stage) {
      const envelope = stage.envelope;
      const tools = [...(envelope?.tools ?? []), ...(envelope?.mcpReadOnlyTools ?? [])]
        .map(name => name + " · " + message("workflowTemplates.noDataSentFlag"));
      for (const tool of [...(envelope?.mcpGenerationTools ?? []), ...(envelope?.pluginGenerationTools ?? [])]) {
        const flag = tool.dataSent ? message("workflowTemplates.sendsToService", { service: tool.name.split(".", 1)[0] })
          : message("workflowTemplates.keepsInputsLocal");
        tools.push(tool.name + " · " + flag);
      }
      const network = envelope?.network.map(({ host, port }) => port === undefined ? host : host + ":" + port);
      const outputs = stage.requestedOutputs?.map(output =>
        workText("output." + output.kind) + " · " + output.toolName + " (" + workText("owner." + output.owner) + " · " + output.ownerId + ")");
      return [
        [message("workflowTemplates.subAgents"), message(stage.allowSubAgents ? "workflowTemplates.subAgentsAllowed" : "workflowTemplates.subAgentsDisabled")],
        [message("workflowTemplates.declaredTools"), tools.join("\n") || undefined],
        [message("workflowTemplates.commands"), envelope?.commands.join("\n") || undefined],
        [message("workflowTemplates.writePaths"), envelope?.writePaths.join("\n") || undefined],
        [message("workflowTemplates.readRoots"), envelope?.readRoots.join("\n") || undefined],
        [message("workflowTemplates.networkHosts"), network?.join("\n") || undefined],
        [message("workflowTemplates.requestedOutputs"), outputs?.join("\n") || undefined],
      ];
    }
    function graphReview(parent, graph) {
      const graphDetails = detail(parent, message("workflowTemplates.stageGraph"));
      graphDetails.open = true;
      for (const stage of graph.stages) {
        const stageDetails = detail(graphDetails, stage.name);
        const predecessors = graph.edges.filter(edge => edge.to === stage.id).map(edge =>
          graph.stages.find(candidate => candidate.id === edge.from)?.name ?? edge.from);
        const gate = stage.gate.type === "human" ? message("workflowTemplates.humanGate")
          : stage.gate.pass.kind === "model_verdict" ? message("workflowTemplates.modelGate")
          : stage.gate.pass.kind === "check_exit_zero" ? stage.gate.pass.command : message("workflowTemplates.successGate");
        facts(stageDetails, [
          [workText("stageId"), stage.id],
          [message("workflowTemplates.goal"), stage.goal],
          [workText("gate"), gate],
          [workText("agent"), stage.agentName],
          [workText("prerequisites"), predecessors.join(", ") || undefined],
          [workText("tools"), message(stage.toolScope === "read" ? "workflowTemplates.readTools" : "workflowTemplates.allTools")],
          ...stageCapabilities(stage),
        ]);
      }
      if (graph.setupCommands?.length) evidence(graphDetails, message("workflowTemplates.setupCommands"), graph.setupCommands.join("\n"));
      const full = detail(graphDetails, message("workflowTemplates.graphDetails"));
      full.append(element("pre", JSON.stringify(graph, null, 2)));
    }
    function outputReview(parent, outputs) {
      for (const output of outputs) {
        const card = detail(parent, output.summary);
        card.open = true;
        facts(card, [
          [workText("outputId"), output.id],
          [workText("outputKind"), workText("output." + output.decl.kind)],
          [workText("outputOwner"), workText("owner." + output.decl.owner) + " · " + output.decl.ownerId],
          [workText("tool"), output.decl.toolName],
        ]);
        if (output.push) facts(card, [
          [workText("pushRemote"), output.push.remote], [workText("outputTarget"), output.push.url],
          [workText("pushRef"), output.push.ref], [workText("pushCommit"), output.push.sha],
        ]);
        for (const file of output.files ?? []) {
          facts(card, [
            [workText("file"), file.path], [workText("fileHash"), file.sha256], [workText("fileSize"), file.size],
          ]);
        }
      }
    }
    const repeatLabels = {
      none: "routinePanel.repeatNone", daily: "routinePanel.repeatDaily", weekly: "routinePanel.repeatWeekly",
      monthly: "routinePanel.repeatMonthly", interval: "routinePanel.repeatInterval", cron: "routinePanel.cronSchedule",
    };
    function scheduleReview(body, item) {
      const { input: binding } = item.binding;
      const { existingPin, routine } = item.review;
      body.append(element("p", message("workflowSchedule.approvalDescription")));
      facts(body, [[message("workflowTemplates.scope"), project(binding.expectedScope)]]);
      if (existingPin) {
        body.append(element("h4", workText("existingPin")));
        facts(body, pinRows(existingPin));
      }
      const schedule = routine?.schedule ?? binding.schedule;
      const repeat = schedule?.repeat;
      if (schedule) {
        facts(body, [
          [message("workflowSchedule.firstFire"), schedule.at && new Date(schedule.at).toLocaleString(boot.locale)],
          [message("routinePanel.repeatLabel"), repeat && message(repeatLabels[repeat.kind], { expr: repeat.expression })],
          [workText("interval"), repeat?.intervalMs],
        ]);
      }
      const attention = {
        "attachment-missing": "workflowSchedule.needsReattachOrDelete",
        "attachment-unavailable": "workflowSchedule.attachmentUnavailable",
        "scope-changed": "workflowSchedule.needsReattach",
      };
      const skip = routine?.lastTemplateSkip;
      if (routine?.pausedAt) body.append(element("p", workText("schedulePaused")));
      if (routine?.templateAttention) body.append(element("p", message(attention[routine.templateAttention])));
      if (skip) body.append(element("p", message(skip.code === "run-unsettled" ? "workflowSchedule.skippedUnsettled"
        : skip.code === "attachment-replaced" ? "workflowSchedule.skippedReplaced" : "workflowSchedule.skippedUnavailable",
        { tool: reveal(skip.tool?.name ?? "") })));
      if (routine?.lastFailure) body.append(element("p", message("workflowSchedule.failed")));
    }
    function renderPayload(body, item, linkedOutput) {
      const view = item.review;
      switch (item.kind) {
        case "plan":
          if (view.stale) body.append(element("p", message("workBoard.planDecisionStale")));
          facts(body, [
            [message("workApprovals.planFactProject"), view.scope.projectRoot ?? message("workApprovals.planFactNoProject")],
            [message("workApprovals.planFactPlannedAt"), new Date(view.arrivedAt).toLocaleString(boot.locale)],
            [message("workApprovals.planFactRevisions"), message("workApprovals.planFactRevisionsValue", { count: view.revision })],
            [workText("planNumber"), view.planNumber],
            [workText("agent"), view.agentName],
            [message("workApprovals.planFactTools"), message("workApprovals.planFactToolsValue")],
          ]);
          evidence(body, message("workApprovals.planAgentHeading"), view.plan);
          body.append(element("p", message("workApprovals.planFactExactPlan")));
          break;
        case "stage":
          evidence(body, message("workflowTemplates.stageResult"), view.result);
          if (linkedOutput) {
            body.append(element("h4", message("workflowTemplates.requestedOutputs")));
            outputReview(body, linkedOutput.review.outputs);
          } else if (view.outputs?.length) {
            body.append(element("h4", message("workflowTemplates.requestedOutputs")));
            const summaries = element("ul");
            for (const output of view.outputs) summaries.append(element("li", output.summary));
            body.append(summaries, element("p", message("reasonCodes.requested-output-unavailable")));
          }
          break;
        case "join": {
          body.append(element("p", message("workflowTemplates.joinReason." + view.evidence.reason)));
          const files = element("ul");
          for (const file of view.evidence.files) files.append(element("li", file.path + " · " + file.stageIds.join(", ")));
          if (files.childElementCount) body.append(files);
          evidence(body, workText("conflictExcerpt"), view.evidence.excerpt);
          break;
        }
        case "template-confirmation":
          body.append(element("p", message("workflowTemplates.confirmationDescription")));
          if (view.description) body.append(element("p", view.description));
          facts(body, [[message("workflowTemplates.scope"), project(view.scope)], [workText("basedOn"), view.basedOn]]);
          if (view.basedOn !== undefined) body.append(element("p", message("workflowTemplates.versionPins")));
          graphReview(body, { stages: view.stages, edges: view.edges, setupCommands: view.setupCommands });
          break;
        case "create-and-run":
          body.append(element("p", message("workflowTemplates.runDescription")));
          facts(body, [[message("workflowTemplates.scope"), project(view.scope)]]);
          graphReview(body, view.graph);
          break;
        case "schedule-attachment":
          scheduleReview(body, item);
          break;
        case "requested-output":
          body.append(element("p", workText("outputApproval")));
          outputReview(body, view.outputs);
          break;
        default:
          throw new Error("Unknown work review kind");
      }
    }

    function actionInput(item, body, formSchedule, draft) {
      const bound = item.binding.input;
      if (item.kind === "create-and-run") {
        const title = field(body, message("workflowTemplates.workTitle"), input("text", draft.title ?? bound.title));
        title.maxLength = 256;
        title.addEventListener("input", () => { draft.title = title.value; });
        const root = field(body, workText("project"), element("select"));
        if (!item.review.projects.length) root.add(new Option(message("workflowTemplates.noProject"), ""));
        for (const option of item.review.projects) {
          root.add(new Option(reveal(option.projectName + " · " + option.projectRoot), option.projectRoot));
        }
        root.value = draft.projectRoot ?? bound.projectRoot ?? "";
        if (draft.projectRoot !== undefined && root.selectedIndex < 0) {
          root.value = bound.projectRoot ?? "";
          draft.projectRoot = root.value;
          draft.projectReset = true;
        }
        const notice = element("p", workText("projectReset"));
        notice.hidden = !draft.projectReset;
        notice.setAttribute("aria-live", "polite");
        body.append(notice);
        root.addEventListener("input", () => {
          draft.projectRoot = root.value;
          draft.projectReset = false;
          notice.hidden = true;
        });
        const notes = field(body, message("workBoard.detailFieldLabel"), element("textarea"));
        notes.value = draft.detail ?? bound.detail ?? "";
        notes.maxLength = 16384;
        notes.addEventListener("input", () => { draft.detail = notes.value; });
        if (item.review.scope.kind === "project" && !root.value) body.append(element("p", message("workflowTemplates.projectMismatch")));
        return {
          valid: () => Boolean(title.value.trim()) && (item.review.scope.kind === "all" || Boolean(root.value)),
          read: () => ({ ...bound, title: title.value.trim(), projectRoot: root.value || undefined, detail: notes.value.trim() || undefined }),
        };
      }
      if (formSchedule) {
        const at = field(body, message("workflowSchedule.firstFire"), input("datetime-local", draft.at));
        const repeat = field(body, message("routinePanel.repeatLabel"), element("select"));
        for (const kind of ["none", "daily", "weekly", "monthly"]) repeat.add(new Option(message(repeatLabels[kind]), kind));
        repeat.value = draft.repeat ?? "none";
        at.addEventListener("input", () => { draft.at = at.value; });
        repeat.addEventListener("input", () => { draft.repeat = repeat.value; });
        return {
          valid: () => Number.isFinite(new Date(at.value).getTime()),
          read: () => ({ ...bound, schedule: { at: new Date(at.value).toISOString(), repeat: { kind: repeat.value } } }),
        };
      }
      return { valid: () => true, read: () => bound };
    }
    function reviewIdentity(item, kind = item.kind) {
      const { input, itemId, templateId } = item.binding;
      switch (kind) {
        case "plan": return JSON.stringify([kind, itemId, input.runId]);
        case "stage":
        case "requested-output": return JSON.stringify([kind, itemId ?? input.itemId, input.runId, input.stageId]);
        case "join": return JSON.stringify([kind, itemId, input.runId, input.joinId]);
        case "template-confirmation": return JSON.stringify([kind, templateId]);
        case "create-and-run": return JSON.stringify([kind, input.templateId]);
        case "schedule-attachment": return JSON.stringify([kind, input.scheduleId ?? null, input.templateId]);
        default: throw new Error("Unknown work review identity");
      }
    }
    function sameOutput(left, right) {
      return left.outputHash !== undefined && left.outputHash === right.outputHash && left.attempt === right.attempt;
    }
    function reviewRevision(item) {
      const { input } = item.binding;
      switch (item.kind) {
        case "plan": return item.review.revision;
        case "stage":
        case "requested-output": return input.attempt;
        case "join": return input.generation;
        case "template-confirmation": return input.expectedDraftRevision;
        case "create-and-run":
        case "schedule-attachment": return input.version;
        default: throw new Error("Unknown work review revision");
      }
    }
    function submissionKey(identity, revision) {
      return JSON.stringify([identity, revision]);
    }
    function outputPeerIdentity(item) {
      if (item.kind === "stage") return reviewIdentity(item, "requested-output");
      if (item.kind === "requested-output") return reviewIdentity(item, "stage");
    }
    function currentSubmission(item, identity) {
      const revision = reviewRevision(item);
      const own = submissions.get(submissionKey(identity, revision));
      const peer = outputPeerIdentity(item);
      if (own || !peer) return own;
      // A matching output may appear after a stage decision was already sent.
      const related = submissions.get(submissionKey(peer, revision));
      if (related && sameOutput(item.binding.input, related.submittedBinding.input)) return related;
    }
    function isSubmittedBinding(item, submission) {
      const { submittedBinding, identity } = submission;
      if (identity !== reviewIdentity(item)) {
        // A stage and its requested outputs can decide the same gate.
        return sameOutput(item.binding.input, submittedBinding.input);
      }
      if (item.kind === "create-and-run" || item.kind === "schedule-attachment") {
        const { version, graphHash, expectedScope } = item.binding.input;
        return version === submittedBinding.input.version && graphHash === submittedBinding.input.graphHash
          && JSON.stringify(expectedScope) === JSON.stringify(submittedBinding.input.expectedScope);
      }
      return JSON.stringify(item.binding) === JSON.stringify(submittedBinding);
    }
    function reviewActions(item, submission, linked, valid) {
      const result = submission?.result;
      const pending = result?.status === "pending";
      const refused = result?.status === "refused";
      const repeatable = item.kind === "create-and-run" || item.kind === "schedule-attachment";
      const sameBinding = submission && isSubmittedBinding(item, submission);
      const locked = pending || sameBinding || (repeatable && Boolean(result) && !refused);
      const mismatch = refused && /[-_]mismatch$/.test(result.code);
      const alternative = !pending && (!locked || mismatch || result?.code === "plan_stale");
      const missingOutput = item.kind === "stage" && item.binding.input.outputHash && (!linked || !item.reviewHandle)
        || item.kind === "requested-output" && !item.reviewHandle;
      return {
        approve: !locked && valid && !missingOutput && !(item.kind === "plan" && item.review.stale),
        alternative,
        edit: !locked,
        reopen: !pending && (refused || result?.status === "success" || (!result && item.kind === "schedule-attachment")),
      };
    }
    function syncCards() {
      for (const state of states.values()) state.card?.sync();
    }
    function refusal(code) {
      if (code === "plan_stale") return message("workBoard.planDecisionStale");
      if (code === "stale-draft" || code === "no-draft") return message("workflowTemplates.staleDraft");
      if (code === "web-session-revoked" || code === "web-session-required" || code === "pairing-share-required") {
        return message("reasonCodes.remote-controller-authority-revoked");
      }
      if (code === "idempotency-conflict") return message("reasonCodes.work-decision-replayed");
      const key = "reasonCodes." + code.replaceAll("_", "-");
      return Object.hasOwn(boot.messages, key) ? message(key) : workText("refused", { code });
    }
    function resultText(result) {
      return result.status === "refused" ? refusal(result.code)
        : workText({ pending: "submitting", success: result.outputGate ? "outputGateAccepted" : "submitted", unknown: "submissionUnknown" }[result.status]);
    }
    function resultIsError(result) {
      return result.status === "refused" || result.status === "unknown";
    }
    function syncRecentHeading() {
      recentHeading.hidden = !latestSnapshot || recentResults.childElementCount === 0;
    }
    function recordRecent(submission) {
      const entry = element("div");
      entry.className = "work-review-recent-entry";
      entry.dataset.submissionOrder = String(submission.order);
      const description = element("p", [
        submission.heading, submission.title, message(submission.actionLabel),
        workText("resultRevision", { revision: submission.revision }), resultText(submission.result),
      ].filter(Boolean).join(" · "));
      description.className = "work-review-feedback";
      description.toggleAttribute("data-error", resultIsError(submission.result));
      const dismiss = element("button", workText("dismissResult"));
      dismiss.type = "button";
      dismiss.addEventListener("click", () => {
        entry.remove();
        syncRecentHeading();
        (recentResults.querySelector("button") ?? reload).focus();
      });
      entry.append(description, dismiss);
      const next = Array.from(recentResults.children).find(child => Number(child.dataset.submissionOrder) > submission.order);
      recentResults.insertBefore(entry, next ?? null);
      syncRecentHeading();
    }
    function reconcileSubmissions(replacedKey) {
      const current = new Set();
      for (const [identity, item] of reviews) current.add(currentSubmission(item, identity));
      for (const [key, submission] of submissions) {
        if (submission.result.status === "pending") continue;
        const item = reviews.get(submission.identity);
        const onCard = item && key === submissionKey(submission.identity, reviewRevision(item)) && !submission.superseded;
        if (!onCard && !submission.movedToRecent && !submission.dismissedFor.has(submission.identity)) {
          recordRecent(submission);
          submission.movedToRecent = true;
        }
        if (key === replacedKey || !current.has(submission)) submissions.delete(key);
      }
    }
    function beginOwnerAction() {
      recentResults.replaceChildren();
      syncRecentHeading();
    }
    function supersedePriorResults(identity, replacedKey) {
      for (const submission of submissions.values()) {
        if (submission.identity === identity) submission.superseded = true;
      }
      reconcileSubmissions(replacedKey);
    }
    function clear(text) {
      outputList?.replaceChildren();
      executionCards.clear();
      retryList?.replaceChildren();
      retries.clear();
      for (const state of states.values()) {
        state.card?.node.remove();
        state.card = undefined;
      }
      latestSnapshot = undefined;
      recentResults.hidden = true;
      syncRecentHeading();
      if (!text) section.hidden = true;
      reload.disabled = revoked;
      empty.hidden = true;
      feedback.toggleAttribute("data-error", Boolean(text));
      feedback.textContent = text ?? "";
    }
    function forgetReviews() {
      states.clear();
      reviews.clear();
      submissions.clear();
      recentResults.replaceChildren();
    }
    function revoke(text) {
      revoked = true;
      scope = undefined;
      clear(section.hidden ? undefined : text);
      forgetReviews();
    }
    async function submit(state, item, reviewedScope, actionLabel, decision, read, note, formSchedule) {
      const submittedBinding = { ...item.binding, input: read() };
      const { identity } = state;
      const revision = reviewRevision(item);
      const key = submissionKey(identity, revision);
      const stage = item.kind === "requested-output" ? reviews.get(outputPeerIdentity(item)) : undefined;
      const title = item.kind === "create-and-run" ? submittedBinding.input.title : stage?.review.title ?? reviewTitle(item);
      const routine = item.review.routine?.title;
      const submission = {
        identity, submittedBinding, heading: reviewHeading(item, formSchedule), actionLabel, revision, order: ++submissionOrder,
        title: routine && routine !== title ? routine + " · " + title : title,
        result: { status: "pending" }, dismissedFor: new Set(),
      };
      supersedePriorResults(identity, key);
      submissions.set(key, submission);
      if (note) {
        delete state.draft.changeNote;
        delete state.draft.changeNoteOpen;
      } else if (item.kind === "create-and-run" || formSchedule) {
        state.draft = {};
      }
      syncCards();
      const isCurrent = () => scope === reviewedScope && !revoked && submissions.get(key) === submission;
      try {
        const response = await request(boot.workDecisionPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: crypto.randomUUID(), scope: reviewedScope, kind: item.kind, ...submittedBinding,
            ...(decision === "approve" && item.reviewHandle ? { reviewHandle: item.reviewHandle } : {}),
            input: { ...submittedBinding.input, ...(decision === undefined ? {} : { decision }), ...(note ? { note } : {}) },
          }),
        });
        const body = await response.json();
        if (!isCurrent()) return;
        if (!response.ok || body.ok !== true) {
          const code = typeof body.error === "string" ? body.error : "work-decision-unavailable";
          const text = refusal(code);
          if (["remote-controller-authority-revoked", "web-session-revoked", "web-session-required", "pairing-share-required"].includes(code)) revoke(text);
          else if (code === "work-decision-scope-mismatch") {
            clear(text);
            forgetReviews();
          } else {
            submission.result = { status: "refused", code };
          }
          return;
        }
        submission.result = { status: "success", outputGate: decision === "approve" && Boolean(item.reviewHandle) };
        scheduleRefresh(false);
      } catch {
        if (isCurrent()) submission.result = { status: "unknown" };
      } finally {
        if (isCurrent()) {
          reconcileSubmissions();
          syncCards();
        }
      }
    }
    const headings = {
      plan: "tailnetWorkReviews.plan",
      stage: "workflowTemplates.stageGate",
      join: "workflowTemplates.joinConflict",
      "template-confirmation": "workflowTemplates.reviewVersion",
      "create-and-run": "workflowTemplates.createAndRun",
      "schedule-attachment": "workflowSchedule.attach",
      "requested-output": "workflowTemplates.requestedOutputs",
    };
    const approveLabels = {
      plan: "tailnetWorkReviews.approve",
      stage: "workflowTemplates.approveStage",
      join: "workflowTemplates.retryJoin",
      "template-confirmation": "tailnetWorkReviews.confirm",
      "create-and-run": "workflowTemplates.createAndRun",
      "schedule-attachment": "workflowSchedule.approveAttach",
      "requested-output": "tailnetWorkReviews.approve",
    };
    const rejectLabels = {
      plan: "tailnetWorkReviews.reject", stage: "workflowTemplates.rejectStage", join: "workflowTemplates.rejectJoin",
      "requested-output": "tailnetWorkReviews.reject",
    };
    function reviewHeading(item, formSchedule) {
      return formSchedule ? workText("newSchedule") : message(headings[item.kind]);
    }
    function reviewTitle(item) {
      const view = item.review;
      return view.title ?? view.name ?? view.outputs?.map(output => output.summary).join(" · ");
    }
    function renderCard(item, state, linkedOutput, formSchedule) {
      const { review: view } = item;
      const node = element("details");
      node.className = "work-review-card";
      node.dataset.workKind = item.kind;
      const summary = element("summary", reviewHeading(item, formSchedule));
      const title = reviewTitle(item);
      if (view.routine?.title && view.routine.title !== title) summary.append(element("span", view.routine.title));
      if (title) summary.append(element("span", title));
      const body = element("div");
      body.className = "work-review-body";
      facts(body, bindingRows(item));
      renderPayload(body, item, linkedOutput);
      if (item.kind === "stage" && item.binding.input.outputHash && !item.reviewHandle || item.kind === "requested-output" && !item.reviewHandle) {
        body.append(element("p", message("reasonCodes.requested-output-card-unavailable")));
      }
      const draft = state.draft;
      const fields = actionInput(item, body, formSchedule, draft);
      const inputs = body.querySelectorAll("input, select, textarea");
      const actions = element("div");
      actions.className = "work-review-actions";
      const status = element("p");
      status.className = "work-review-feedback";
      status.setAttribute("role", "status");
      status.setAttribute("aria-atomic", "true");
      const reviewedScope = scope;
      const isCurrent = () => state.card?.node === node && node.isConnected && scope === reviewedScope && !revoked;
      const { identity } = state;
      const available = () => reviewActions(item, currentSubmission(item, identity), linkedOutput, fields.valid());
      function resetCard(open) {
        supersedePriorResults(identity, submissionKey(identity, reviewRevision(item)));
        state.draft = {};
        state.card.content = undefined;
        update(latestSnapshot);
        const replacement = state.card.node;
        replacement.open = open;
        const firstControl = open ? replacement.querySelector("input, button:enabled") : undefined;
        (firstControl ?? replacement.querySelector("summary"))?.focus();
      }
      function button(action, label, onClick) {
        const control = element("button", message(label));
        control.type = "button";
        control.dataset.workAction = action;
        control.addEventListener("click", () => {
          if (isCurrent() && !control.disabled && !control.hidden) {
            beginOwnerAction();
            onClick(label);
          }
        });
        actions.append(control);
        return control;
      }
      const decide = (label, decision, note) => void submit(state, item, reviewedScope, label, decision, fields.read, note, formSchedule);
      const approve = button("approve", approveLabels[item.kind], label => {
        if (available().approve) decide(label, item.kind === "join" ? "retry_merge" : item.deny === "reject" ? "approve" : undefined);
      });
      let note;
      let requestChanges;
      if (item.kind === "plan" || item.kind === "stage") {
        note = field(body, message("workflowTemplates.changeNote"), element("textarea"));
        note.value = draft.changeNote ?? "";
        note.maxLength = boot.maxNoteLength;
        note.parentElement.hidden = !draft.changeNoteOpen;
        note.addEventListener("input", () => { draft.changeNote = note.value; });
        requestChanges = button("request_changes", "workflowTemplates.requestChanges", label => {
          if (note.parentElement.hidden) {
            supersedePriorResults(identity);
            draft.changeNoteOpen = true;
            note.parentElement.hidden = false;
            note.focus();
            syncCards();
          } else if (note.value.trim()) {
            decide(label, "request_changes", note.value.trim());
            note.value = "";
            note.parentElement.hidden = true;
          }
        });
      }
      const negative = item.deny === "reject" ? button("reject", rejectLabels[item.kind], label => decide(label, "reject"))
        : button("dismiss", "common.cancel", () => resetCard(false));
      const reopen = item.kind === "create-and-run" || item.kind === "schedule-attachment"
        ? button("reopen", "tailnetWorkReviews.newDecision", () => resetCard(true)) : undefined;
      let displayedSubmission;
      const dismissResult = button("dismiss-result", "tailnetWorkReviews.dismissResult", () => {
        displayedSubmission.dismissedFor.add(identity);
        sync();
      });
      function sync() {
        const { approve: canApprove, alternative, edit, reopen: canReopen } = available();
        approve.disabled = !canApprove;
        negative.disabled = item.deny === "reject" ? !alternative : !edit;
        if (note) note.disabled = !alternative;
        if (requestChanges) requestChanges.disabled = !alternative;
        for (const input of inputs) input.disabled = !edit;
        if (reopen) {
          reopen.disabled = !canReopen;
          reopen.hidden = item.kind !== "schedule-attachment" && !canReopen;
        }
        displayedSubmission = currentSubmission(item, identity);
        const hiddenResult = displayedSubmission?.movedToRecent || displayedSubmission?.dismissedFor.has(identity)
          || (displayedSubmission?.identity === identity && displayedSubmission.superseded);
        const result = hiddenResult ? undefined : displayedSubmission?.result;
        dismissResult.hidden = result?.status !== "refused";
        const text = result ? resultText(result) : "";
        status.toggleAttribute("data-error", Boolean(result && resultIsError(result)));
        if (status.textContent !== text) status.textContent = text;
      }
      body.addEventListener("input", sync);
      body.append(actions, status);
      node.append(summary, body);
      sync();
      return { node, sync };
    }
    function update(snapshot) {
      if (revoked) return;
      if (!snapshot?.workReviews) {
        clear();
        forgetReviews();
        return;
      }
      if (scope !== snapshot.scope) {
        clear();
        forgetReviews();
        scope = snapshot.scope;
      }
      latestSnapshot = snapshot;
      updateExecutionCards(snapshot);
      updateRetries(snapshot);
      reviews = new Map();
      for (const item of snapshot.workReviews) {
        reviews.set(reviewIdentity(item), item);
        if (item.kind === "create-and-run") {
          const { templateId, version, graphHash } = item.binding.input;
          const schedule = {
            kind: "schedule-attachment", deny: "dismiss",
            binding: { input: { templateId, version, graphHash, expectedScope: item.review.scope } },
            review: { name: item.review.name },
          };
          reviews.set(reviewIdentity(schedule), schedule);
        }
      }
      for (const identity of reviews.keys()) {
        if (!states.has(identity)) states.set(identity, { identity, draft: {} });
      }
      let position = list.firstElementChild;
      for (const [identity, item] of reviews) {
        const state = states.get(identity);
        const candidate = item.kind === "stage" ? reviews.get(outputPeerIdentity(item)) : undefined;
        const linked = candidate && sameOutput(item.binding.input, candidate.binding.input) ? candidate : undefined;
        const formSchedule = item.kind === "schedule-attachment" && item.binding.input.scheduleId === undefined;
        const content = JSON.stringify([item, linked]);
        const prior = state.card;
        if (!prior || prior.content !== content) {
          const card = { ...renderCard(item, state, linked, formSchedule), content };
          if (prior) {
            card.node.open = prior.node.open;
            if (position === prior.node) position = card.node;
            prior.node.replaceWith(card.node);
          }
          state.card = card;
        }
        const { card } = state;
        if (card.node !== position) list.insertBefore(card.node, position);
        position = card.node.nextElementSibling;
      }
      for (const [identity, state] of states) {
        if (!reviews.has(identity)) {
          state.card?.node.remove();
          states.delete(identity);
        }
      }
      empty.hidden = reviews.size !== 0 || executionCards.size !== 0 || retries.size !== 0;
      section.hidden = false;
      recentResults.hidden = false;
      syncRecentHeading();
      reconcileSubmissions();
      syncCards();
    }
    return { update, clear, revoke };
  }
  const workReviews = workReviewUi();
`;
