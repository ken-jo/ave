import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import type { TemplateStage, WorkflowTemplateDraftInput } from "../../../../shared/workflow-template-types.js";
import { stageGateKey } from "./workflow-template-graph.js";

export function WorkflowTemplateDetails({ draft, graphHash }: { draft: WorkflowTemplateDraftInput; graphHash: string }) {
  const { t } = useTranslation();
  return (
    <div className="max-h-[55vh] space-y-3 overflow-auto break-words text-sm">
      {draft.description && <p className="whitespace-pre-wrap">{revealHiddenCharacters(draft.description, { lineBreaks: false })}</p>}
      <p>{draft.scope.kind === "all" ? t("workflowTemplates.allProjects") : revealHiddenCharacters(draft.scope.projectRoot, { lineBreaks: true })}</p>
      <ul className="space-y-2">
        {draft.stages.map(stage => {
          const dependencies = draft.edges.filter(edge => edge.to === stage.id).map(edge => edge.from);
          return (
            <li key={stage.id} className="rounded border p-2">
              <p className="font-medium">{revealHiddenCharacters(stage.name, { lineBreaks: true })} <code>({stage.id})</code></p>
              <p className="whitespace-pre-wrap">{revealHiddenCharacters(stage.goal, { lineBreaks: false })}</p>
              <p>{t(stage.toolScope === "read" ? "workflowTemplates.readTools" : "workflowTemplates.allTools")} · {t(stageGateKey(stage.gate))}</p>
              {stage.agentName && <p>{t("workflowTemplates.agentProfile", { name: revealHiddenCharacters(stage.agentName, { lineBreaks: true }) })}</p>}
              {!!dependencies.length && <p>{t("workflowTemplates.afterStages", { stages: dependencies.join(", ") })}</p>}
              <StageCapabilities stage={stage} setupCommands={draft.setupCommands} />
            </li>
          );
        })}
      </ul>
      <details>
        <summary>{t("workflowTemplates.graphDetails")}</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs">
          {revealHiddenCharacters(JSON.stringify(draft, null, 2), { lineBreaks: false })}
        </pre>
      </details>
      <p>{t("workflowTemplates.graphHash")} <code className="break-all">{graphHash}</code></p>
    </div>
  );
}

function StageCapabilities({ stage, setupCommands }: { stage: TemplateStage; setupCommands?: string[] }) {
  const { t } = useTranslation();
  const envelope = stage.envelope;
  const toolsWithoutFlag = [...(envelope?.tools ?? []), ...(envelope?.mcpReadOnlyTools ?? [])];
  const generationTools = [...(envelope?.mcpGenerationTools ?? []), ...(envelope?.pluginGenerationTools ?? [])];
  const tools = [
    ...toolsWithoutFlag.map(name => `${name} · ${t("workflowTemplates.noDataSentFlag")}`),
    ...generationTools.map(tool => {
      const service = tool.name.split(".", 1)[0] || tool.name;
      const flag = tool.dataSent ? t("workflowTemplates.sendsToService", { service }) : t("workflowTemplates.keepsInputsLocal");
      return `${tool.name} · ${flag}`;
    }),
  ];
  const requestedOutputs = stage.requestedOutputs?.map(output =>
    `${output.kind} · ${output.toolName} (${output.owner}/${output.ownerId})`);
  const networkHosts = envelope?.network.map(({ host, port }) => port === undefined ? host : `${host}:${port}`);

  return (
    <dl className="mt-2 space-y-1">
      <CapabilityItems label={t("workflowTemplates.commands")} items={envelope?.commands} />
      <CapabilityItems label={t("workflowTemplates.setupCommands")} items={setupCommands} />
      <CapabilityItems label={t("workflowTemplates.writePaths")} items={envelope?.writePaths} />
      <CapabilityItems label={t("workflowTemplates.readRoots")} items={envelope?.readRoots} />
      <CapabilityItems label={t("workflowTemplates.requestedOutputs")} items={requestedOutputs} />
      <div>
        <dt className="font-medium">{t("workflowTemplates.subAgents")}</dt>
        <dd>{t(stage.allowSubAgents ? "workflowTemplates.subAgentsAllowed" : "workflowTemplates.subAgentsDisabled")}</dd>
      </div>
      <CapabilityItems label={t("workflowTemplates.declaredTools")} items={tools} />
      <CapabilityItems label={t("workflowTemplates.networkHosts")} items={networkHosts} />
    </dl>
  );
}

function CapabilityItems({ label, items }: { label: string; items?: string[] }) {
  const { t } = useTranslation();
  const occurrences = new Map<string, number>();
  return (
    <div>
      <dt className="font-medium">{label}</dt>
      <dd>{items?.length ? (
        <ul className="list-disc pl-5">
          {items.map(item => {
            const occurrence = (occurrences.get(item) ?? 0) + 1;
            occurrences.set(item, occurrence);
            return (
              <li key={`${occurrence}:${item}`} className="whitespace-pre-wrap">
                {revealHiddenCharacters(item, { lineBreaks: true })}
              </li>
            );
          })}
        </ul>
      ) : t("workflowTemplates.none")}</dd>
    </div>
  );
}
