import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import type { TemplateGraph, TemplateStage } from "../../../../shared/workflow-template-types.js";

export function stageDisplayName(name: string): string {
  return revealHiddenCharacters(name, { lineBreaks: true });
}

export function stageGateKey(gate: TemplateStage["gate"]): string {
  if (gate.type === "human") return "workflowTemplates.humanGate";
  switch (gate.pass.kind) {
    case "stage_ok": return "workflowTemplates.successGate";
    case "model_verdict": return "workflowTemplates.modelGate";
    case "check_exit_zero": return "reasonCodes.gate-check-unsupported";
  }
}

export function stageAncestors(graph: TemplateGraph, stageId: string): Set<string> {
  const found = new Set<string>();
  const visit = (id: string) => {
    for (const edge of graph.edges) {
      if (edge.to !== id || found.has(edge.from)) continue;
      found.add(edge.from);
      visit(edge.from);
    }
  };
  visit(stageId);
  return found;
}

function stageLayers(graph: TemplateGraph): TemplateStage[][] {
  const pending = new Set(graph.stages);
  const seen = new Set<string>();
  const layers: TemplateStage[][] = [];
  while (pending.size > 0) {
    const layer = [...pending].filter(stage => graph.edges.every(edge => edge.to !== stage.id || seen.has(edge.from)));
    if (layer.length === 0) throw new Error("Invalid workflow stage dependencies");
    layers.push(layer);
    for (const stage of layer) {
      pending.delete(stage);
      seen.add(stage.id);
    }
  }
  return layers;
}

export function WorkflowStageGraph({ graph, selection, stageStatus }: {
  graph: TemplateGraph;
  selection?: { id: string; onSelect: (id: string) => void };
  stageStatus?: (id: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const names = new Map(graph.stages.map(stage => [stage.id, stageDisplayName(stage.name) || t("workflowTemplates.unnamedStage")]));
  return (
    <ol aria-label={t("workflowTemplates.stageGraph")} className="space-y-2">
      {stageLayers(graph).map((layer, step) => (
        <li key={layer[0].id} className={layer.length > 1 ? "space-y-2 rounded-lg border border-dashed p-2" : "space-y-2 p-2"}>
          <p className="text-xs font-medium text-muted-foreground">
            {t(layer.length > 1 ? "workflowTemplates.parallelGroup" : "workflowTemplates.stageGroup", { step: step + 1 })}
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {layer.map(stage => {
              const prerequisites = graph.edges.filter(edge => edge.to === stage.id).map(edge => names.get(edge.from)).join(", ");
              const status = stageStatus?.(stage.id);
              return <li key={stage.id} className="min-w-0 space-y-1 rounded-md border bg-background p-2 text-sm">
                {selection ? (
                  <Button type="button" size="sm" variant={selection.id === stage.id ? "secondary" : "ghost"}
                    className="h-auto whitespace-normal text-left" aria-pressed={selection.id === stage.id}
                    onClick={() => selection.onSelect(stage.id)}>{names.get(stage.id)}</Button>
                ) : <p className="break-words font-medium">{names.get(stage.id)}</p>}
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline">{t(stageGateKey(stage.gate))}</Badge>
                  {status && <Badge variant="secondary">{status}</Badge>}
                </div>
                {prerequisites && <p className="break-words text-xs text-muted-foreground">{t("workflowTemplates.afterStages", { stages: prerequisites })}</p>}
              </li>;
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
