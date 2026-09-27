import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { Label } from "../../../components/ui/label.js";
import { Textarea } from "../../../components/ui/textarea.js";
import { useTranslation } from "../../../i18n/react.js";
import type { AgentPluginTemplatePrompt } from "../../../shared/agent-plugin-prompt.js";

export function AgentPluginPromptArgsDialog({ prompt, onCancel, onSubmit }: {
  prompt: AgentPluginTemplatePrompt | null;
  onCancel: () => void;
  onSubmit: (prompt: AgentPluginTemplatePrompt, args: string) => void;
}) {
  const { t } = useTranslation();
  const [args, setArgs] = useState("");
  useEffect(() => setArgs(""), [prompt]);
  if (!prompt) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent size="md" data-testid="agent-plugin-prompt-args-dialog">
        <DialogHeader>
          <DialogTitle>{t("agentPluginPrompt.argsTitle", { name: prompt.name })}</DialogTitle>
          <DialogDescription>{t("agentPluginPrompt.argsDescription", { package: prompt.packageName })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); onSubmit(prompt, args); }} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-plugin-prompt-args">{t("agentPluginPrompt.argsLabel")}</Label>
            <Textarea id="agent-plugin-prompt-args" data-testid="agent-plugin-prompt-args" value={args}
              onChange={(event) => setArgs(event.target.value)} placeholder={prompt.argumentHint} maxLength={8192} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
            <Button type="submit">{t("agentPluginPrompt.send")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
