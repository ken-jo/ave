import { useTranslation } from "../../../../i18n/react.js";
import type { UnattendedQualification } from "../../../../shared/workflow-template-types.js";
import { stageDisplayName } from "./workflow-template-graph.js";

export function WorkflowUnattendedMark({ qualification }: { qualification: UnattendedQualification }) {
  const { t } = useTranslation();
  if (qualification.ok || !("tool" in qualification)) return null;
  return <p role="status" className="break-words text-sm">
    {t("workflowTemplates.unattendedMark", { tool: stageDisplayName(qualification.tool.name), reason: t(`reasonCodes.${qualification.code}`) })}
  </p>;
}
