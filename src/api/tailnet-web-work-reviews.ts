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
    || key.startsWith("workflowSchedule.") || key.startsWith("workflowTemplates.joinReason.")));
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
  .work-review-body label { display: grid; gap: .25rem; margin-block: .65rem; }
  .work-review-body :is(input, select, textarea) { box-sizing: border-box; inline-size: 100%; min-inline-size: 0; color: inherit; }
  .work-review-body textarea { min-block-size: 4rem; }
  .work-review-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-block-start: .8rem; }
  #work-reviews button { min-block-size: 44px; padding: .45rem .7rem; }
  #work-reviews button[data-work-action="approve"]:enabled { background: var(--accent); color: var(--on-accent); border-color: transparent; }
  #work-review-feedback:empty { margin: 0; }
  #work-review-feedback[data-error] { color: var(--danger); }
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
    const cards = new Map();
    const closed = new Set();
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
        evidence(card, workText("arguments"), output.args);
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

    function actionInput(item, body, formSchedule) {
      const bound = item.binding.input;
      if (item.kind === "create-and-run") {
        const title = field(body, message("workflowTemplates.workTitle"), input("text", bound.title));
        title.maxLength = 256;
        const root = field(body, workText("project"), element("select"));
        if (!item.review.projects.length) root.add(new Option(message("workflowTemplates.noProject"), ""));
        for (const option of item.review.projects) {
          root.add(new Option(reveal(option.projectName + " · " + option.projectRoot), option.projectRoot));
        }
        root.value = bound.projectRoot ?? "";
        const notes = field(body, message("workBoard.detailFieldLabel"), element("textarea"));
        notes.value = bound.detail ?? "";
        notes.maxLength = 16384;
        if (item.review.scope.kind === "project" && !root.value) body.append(element("p", message("workflowTemplates.projectMismatch")));
        return {
          valid: () => Boolean(title.value.trim()) && (item.review.scope.kind === "all" || Boolean(root.value)),
          read: () => ({ ...bound, title: title.value.trim(), projectRoot: root.value || undefined, detail: notes.value.trim() || undefined }),
        };
      }
      if (formSchedule) {
        const at = field(body, message("workflowSchedule.firstFire"), input("datetime-local"));
        const repeat = field(body, message("routinePanel.repeatLabel"), element("select"));
        for (const kind of ["none", "daily", "weekly", "monthly"]) repeat.add(new Option(message(repeatLabels[kind]), kind));
        return {
          valid: () => Number.isFinite(new Date(at.value).getTime()),
          read: () => ({ ...bound, schedule: { at: new Date(at.value).toISOString(), repeat: { kind: repeat.value } } }),
        };
      }
      return { valid: () => true, read: () => bound };
    }
    function reviewKey(item) {
      return JSON.stringify([scope, item.kind, item.binding]);
    }
    function outputKey(item) {
      const { input: binding } = item.binding;
      if (item.kind !== "requested-output" && (item.kind !== "stage" || !binding.outputHash)) return undefined;
      return JSON.stringify([scope, "output-gate", item.binding.itemId ?? binding.itemId,
        binding.runId, binding.stageId, binding.attempt, binding.outputHash]);
    }
    function showFeedback(text, error = false) {
      feedback.toggleAttribute("data-error", error);
      feedback.textContent = text;
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
    function clear(text) {
      for (const card of cards.values()) card.node.remove();
      cards.clear();
      latestSnapshot = undefined;
      if (!text) section.hidden = true;
      reload.disabled = revoked;
      empty.hidden = true;
      showFeedback(text ?? "", Boolean(text));
    }
    function revoke(text) {
      revoked = true;
      scope = undefined;
      clear(section.hidden ? undefined : text);
    }
    async function submit(card, item, reviewedScope, decision, read, note) {
      if (card.node.isConnected === false || scope !== reviewedScope || revoked || closed.has(card.actionKey)) return;
      closed.add(card.actionKey);
      for (const related of cards.values()) if (related.actionKey === card.actionKey) related.disable();
      showFeedback(workText("submitting"));
      try {
        const response = await request(boot.workDecisionPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: crypto.randomUUID(), scope: reviewedScope, kind: item.kind, ...item.binding,
            input: { ...read(), ...(decision === undefined ? {} : { decision }), ...(note ? { note } : {}) },
          }),
        });
        const body = await response.json();
        if (scope !== reviewedScope || revoked || section.hidden) return;
        if (!response.ok || body.ok !== true) {
          const code = typeof body.error === "string" ? body.error : "work-decision-unavailable";
          const text = refusal(code);
          if (["remote-controller-authority-revoked", "web-session-revoked", "web-session-required", "pairing-share-required"].includes(code)) revoke(text);
          else if (code === "work-decision-scope-mismatch") clear(text);
          else showFeedback(text, true);
          return;
        }
        showFeedback(workText("submitted"));
        scheduleRefresh(false);
      } catch {
        if (scope === reviewedScope && !revoked && !section.hidden) showFeedback(workText("submissionUnknown"), true);
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
    function renderCard(item, key, linkedOutput, formSchedule) {
      const { review: view } = item;
      const node = element("details");
      node.className = "work-review-card";
      node.dataset.workKind = item.kind;
      const summary = element("summary", formSchedule ? workText("newSchedule") : message(headings[item.kind]));
      const title = view.routine?.title ?? view.title ?? view.name ?? view.outputs?.map(output => output.summary).join(" · ");
      if (title) summary.append(element("span", title));
      const body = element("div");
      body.className = "work-review-body";
      facts(body, bindingRows(item));
      renderPayload(body, item, linkedOutput);
      const fields = actionInput(item, body, formSchedule);
      const actions = element("div");
      actions.className = "work-review-actions";
      const reviewedScope = scope;
      const actionKey = outputKey(item) ?? key;
      const card = {
        node, actionKey,
        disable: () => body.querySelectorAll("button, input, select, textarea").forEach(control => { control.disabled = true; }),
      };
      function button(action, label, onClick) {
        const control = element("button", message(label));
        control.type = "button";
        control.dataset.workAction = action;
        control.addEventListener("click", onClick);
        actions.append(control);
        return control;
      }
      const canApprove = () => fields.valid()
        && !(item.kind === "plan" && view.stale)
        && !(item.kind === "stage" && view.outputs?.length && item.binding.input.outputHash && !linkedOutput);
      const approve = button("approve", approveLabels[item.kind], () => {
        if (canApprove()) void submit(card, item, reviewedScope,
          item.kind === "join" ? "retry_merge" : item.deny === "reject" ? "approve" : undefined, fields.read);
      });
      approve.disabled = !canApprove();
      body.addEventListener("input", () => { approve.disabled = closed.has(actionKey) || !canApprove(); });
      if (item.kind === "plan" || item.kind === "stage") {
        const note = field(body, message("workflowTemplates.changeNote"), element("textarea"));
        note.maxLength = boot.maxNoteLength;
        note.parentElement.hidden = true;
        button("request_changes", "workflowTemplates.requestChanges", () => {
          if (note.parentElement.hidden) {
            note.parentElement.hidden = false;
            note.focus();
          } else if (note.value.trim()) {
            void submit(card, item, reviewedScope, "request_changes", fields.read, note.value.trim());
          }
        });
      }
      if (item.deny === "reject") button("reject", rejectLabels[item.kind], () => {
        void submit(card, item, reviewedScope, "reject", fields.read);
      });
      else button("dismiss", "common.cancel", () => {
        closed.add(key);
        update(latestSnapshot);
      });
      body.append(actions);
      node.append(summary, body);
      if (closed.has(actionKey)) card.disable();
      return card;
    }
    function update(snapshot) {
      if (revoked) return;
      if (!snapshot?.workReviews) {
        clear();
        return;
      }
      if (scope !== snapshot.scope) {
        clear();
        closed.clear();
        scope = snapshot.scope;
      }
      latestSnapshot = snapshot;
      const reviews = snapshot.workReviews;
      const outputs = new Map(reviews.filter(item => item.kind === "requested-output").map(item => [outputKey(item), item]));
      const next = new Set();
      let position = list.firstElementChild;
      function show(item, formSchedule = false) {
        const key = reviewKey(item);
        if (item.deny === "dismiss" && closed.has(key)) return;
        next.add(key);
        const linkedOutput = item.kind === "stage" ? outputs.get(outputKey(item)) : undefined;
        const content = JSON.stringify([item.review, linkedOutput?.review]);
        let card = cards.get(key);
        if (!card || card.content !== content) {
          const prior = card;
          card = { ...renderCard(item, key, linkedOutput, formSchedule), content };
          if (prior) {
            card.node.open = prior.node.open;
            if (position === prior.node) position = card.node;
            prior.node.replaceWith(card.node);
          }
          cards.set(key, card);
        }
        if (card.node !== position) list.insertBefore(card.node, position);
        position = card.node.nextElementSibling;
      }
      for (const item of reviews) {
        show(item);
        if (item.kind === "create-and-run") {
          const { templateId, version, graphHash } = item.binding.input;
          show({
            kind: "schedule-attachment", deny: "dismiss",
            binding: { input: { templateId, version, graphHash, expectedScope: item.review.scope } },
            review: { name: item.review.name },
          }, true);
        }
      }
      for (const [key, card] of cards) {
        if (!next.has(key)) {
          card.node.remove();
          cards.delete(key);
        }
      }
      empty.hidden = cards.size !== 0;
      section.hidden = false;
    }
    return { update, clear, revoke };
  }
  const workReviews = workReviewUi();
`;
