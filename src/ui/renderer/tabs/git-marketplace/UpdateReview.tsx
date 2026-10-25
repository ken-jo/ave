/** Consent changes need explicit approval; component approval is bound to the installed generation. Keep labels literal for
 * catalog-key validation. */
import { useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Checkbox } from "../../../../components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { TranslateFn as Translate } from "../../../../i18n/translate.js";
import type {
  ComponentConsent,
  ConsentDelta,
  ConsentDeltaEntry,
  ConsentJson,
  GitMarketplaceApi,
  GitMarketplaceFailure,
  PackageUpdateView,
  ReviewedComponentConsent,
  UpdatePlanView,
} from "../../../../shared/git-marketplace.js";
import { MarketplaceProblem } from "./MarketplaceProblem.js";
import { OTHER_SUBJECT } from "./labels.js";

/** A consent field's label (§18.7.3's table). A field outside it is a contract violation between main and this renderer. */
function consentFieldLabel(t: Translate, field: string): string {
  if (field.startsWith("mcpServer:")) return t("gitMarketplace.consent.field.mcpServer", { id: field.slice("mcpServer:".length) });
  if (field.startsWith("hook:")) return t("gitMarketplace.consent.field.hook", { id: field.slice("hook:".length) });
  switch (field) {
    case "*": return t("gitMarketplace.consent.field.all");
    case "minAppVersion": return t("gitMarketplace.consent.field.minAppVersion");
    case "hostProtocol": return t("gitMarketplace.consent.field.hostProtocol");
    case "authority.capabilities": return t("gitMarketplace.consent.field.capabilities");
    case "authority.networkAccess": return t("gitMarketplace.consent.field.networkAccess");
    case "authority.hostSecrets": return t("gitMarketplace.consent.field.hostSecrets");
    case "authority.pluginAccess": return t("gitMarketplace.consent.field.pluginAccess");
    case "authority.auth": return t("gitMarketplace.consent.field.auth");
    case "authority.dependencies": return t("gitMarketplace.consent.field.dependencies");
    case "authority.sandbox": return t("gitMarketplace.consent.field.sandbox");
    case "authority.requires.capabilities": return t("gitMarketplace.consent.field.requiredCapabilities");
    case "entryForm": return t("gitMarketplace.consent.field.entryForm");
    case "contributionKinds": return t("gitMarketplace.consent.field.contributionKinds");
    case "processTree": return t("gitMarketplace.consent.field.processTree");
    case "componentKinds": return t("gitMarketplace.consent.field.componentKinds");
    case "mcpAuth": return t("gitMarketplace.consent.field.mcpAuth");
    case "mcpRuntime": return t("gitMarketplace.consent.field.mcpRuntime");
    case "providerId": return t("gitMarketplace.consent.field.providerId");
    case "baseUrl": return t("gitMarketplace.consent.field.baseUrl");
    case "connection": return t("gitMarketplace.consent.field.connection");
  }
  throw new Error(`consent field ${field} has no label`);
}

const DIGEST = /^[a-f0-9]{64}$/u;

/** A fingerprint value as one line: digests shortened, lists joined, records as their fields, nothing as "none". */
function consentValue(t: Translate, value: ConsentJson | "unknown"): string {
  if (value === "unknown") return t("gitMarketplace.consent.unknown");
  if (value === null) return t("gitMarketplace.consent.none");
  if (typeof value === "string") return DIGEST.test(value) ? value.slice(0, 12) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? t("gitMarketplace.consent.none") : value.map((item) => consentValue(t, item)).join(", ");
  const fields = Object.entries(value);
  return fields.length === 0 ? t("gitMarketplace.consent.none") : fields.map(([key, item]) => `${key}: ${consentValue(t, item)}`).join(" · ");
}

function DeltaRow({ entry, approve }: { entry: ConsentDeltaEntry; approve?: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean } }) {
  const { t } = useTranslation();
  const body = (
    <span className="min-w-0 space-y-0.5">
      <span className="block font-medium">{consentFieldLabel(t, entry.field)}</span>
      <span className="block break-all text-muted-foreground">
        {t("gitMarketplace.consent.change", { before: consentValue(t, entry.before), after: consentValue(t, entry.after) })}
      </span>
      {entry.changedFiles && entry.changedFiles.code.length > 0 && (
        <span className="block break-all text-muted-foreground">{t("gitMarketplace.consent.changedCode", { files: entry.changedFiles.code.join(", ") })}</span>
      )}
      {entry.changedFiles && entry.changedFiles.nonCode.length > 0 && (
        <span className="block break-all text-muted-foreground">{t("gitMarketplace.consent.changedOther", { files: entry.changedFiles.nonCode.join(", ") })}</span>
      )}
    </span>
  );
  return (
    <li className="text-xs" data-testid={`git-marketplace:consent-row:${entry.field}`}>
      {approve ? (
        <label className="flex items-start gap-2">
          <Checkbox checked={approve.checked} disabled={approve.disabled} onCheckedChange={(checked) => approve.onChange(checked === true)} data-testid={`git-marketplace:consent-approve:${entry.field}`} />
          {body}
        </label>
      ) : body}
    </li>
  );
}

/** The delta rows; a field listed in `approvable` gets an approve box. */
function ConsentDeltaRows({ delta, approvable, approved, onApprovedChange, disabled }: {
  delta: ConsentDelta;
  approvable: ReadonlySet<string>;
  approved: Readonly<Record<string, boolean>>;
  onApprovedChange: (field: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="space-y-2" data-testid="git-marketplace:consent-delta">
      {delta.map((entry) => (
        <DeltaRow
          key={`${entry.checkpoint}:${entry.field}`}
          entry={entry}
          {...(approvable.has(entry.field) ? { approve: { checked: approved[entry.field] === true, onChange: (checked: boolean) => onApprovedChange(entry.field, checked), ...(disabled ? { disabled } : {}) } } : {})}
        />
      ))}
    </ul>
  );
}

/** The components an update review approves: every one the review lists when the change is code-free (*Approve update*
 * approves them in one step), otherwise the ones whose box is checked. */
export function updateConsents(plan: UpdatePlanView, approved: Readonly<Record<string, boolean>>): ComponentConsent[] {
  return approvableComponents(plan).filter((component) => plan.codeFreeChange || approved[component.field] === true).map((component) => component.consent);
}

/** An agent plugin's hook cannot be approved where hooks cannot be confined, as at install. */
function approvableComponents(plan: UpdatePlanView): UpdatePlanView["reviewComponents"] {
  return plan.reviewComponents.filter((component) => !(component.kind === "hook" && plan.hookConfinement === "unavailable"));
}

/** The update review's consent section (§18.7.3), inside the package sheet. */
export function UpdateConsentReview({ plan, approved, onApprovedChange }: {
  plan: UpdatePlanView;
  approved: Readonly<Record<string, boolean>>;
  onApprovedChange: (field: string, checked: boolean) => void;
}) {
  const { t } = useTranslation();
  if (plan.codeFreeChange) {
    const files = [...new Set(plan.consentDelta.flatMap((entry) => entry.changedFiles?.nonCode ?? []))].sort();
    return (
      <div className="space-y-1 rounded-md border px-3 py-2 text-xs" data-testid="git-marketplace:code-free">
        <p className="font-medium">{t("gitMarketplace.consent.codeFree")}</p>
        <ul className="list-disc space-y-0.5 pl-4 font-mono">
          {files.map((file) => <li key={file} className="break-all">{file}</li>)}
        </ul>
      </div>
    );
  }
  if (plan.consentDelta.length === 0) {
    return <p className="text-xs text-muted-foreground" data-testid="git-marketplace:consent-unchanged">{t("gitMarketplace.consent.unchanged")}</p>;
  }
  return (
    <div className="space-y-1" data-testid="git-marketplace:consent-review">
      <p className="text-xs font-medium">{t("gitMarketplace.consent.title")}</p>
      {plan.reviewComponents.length > 0 && <p className="text-xs text-muted-foreground">{t("gitMarketplace.consent.approveHelp")}</p>}
      <ConsentDeltaRows
        delta={plan.consentDelta}
        approvable={new Set(approvableComponents(plan).map((component) => component.field))}
        approved={approved}
        onApprovedChange={onApprovedChange}
      />
    </div>
  );
}

/** The consent field of an agent plugin's component consent. */
function agentField(consent: ReviewedComponentConsent): string {
  return "kind" in consent ? `hook:${consent.index}` : `mcpServer:${consent.name}`;
}

/**
 * The component mode of an `approval-pending` agent plugin (§18.7.5): the
 * unapproved components' rows, approved through `components:approve` for
 * the installed generation this review shows. When that generation changed,
 * nothing is approved, the sentence says so, and the review shows the new
 * one once `onReload` has read it.
 */
export function ComponentApprovalDialog({ api, update, onClose, onReload }: {
  api: Pick<GitMarketplaceApi, "approveComponents">;
  update: PackageUpdateView | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<GitMarketplaceFailure | null>(null);
  const pending = update?.pendingApproval ?? null;
  const [reviewed, setReviewed] = useState<string | null>(null);
  // A new installed generation is a new review: nothing checked carries over.
  if (pending && pending.installId !== reviewed) {
    setReviewed(pending.installId);
    setApproved({});
  }

  const approve = async () => {
    if (!update || !pending) return;
    const consents = pending.components.filter((consent) => approved[agentField(consent)] === true);
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.approveComponents(update.key, pending.installId, consents);
      if (result.ok) {
        onClose();
        return;
      }
      setFailure(result);
      if (result.code === "PLAN_EXPIRED") onReload();
    } finally {
      setBusy(false);
    }
  };

  const fields = new Set(pending?.components.map(agentField) ?? []);
  const anyChecked = [...fields].some((field) => approved[field] === true);
  return (
    <Dialog open={update !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl" data-testid="git-marketplace:approval">
        <DialogHeader>
          <DialogTitle>{update ? t("gitMarketplace.approval.title", { name: update.displayName }) : null}</DialogTitle>
          <DialogDescription>{t("gitMarketplace.approval.description")}</DialogDescription>
        </DialogHeader>
        {failure && <MarketplaceProblem failure={failure} subject={OTHER_SUBJECT} testId="git-marketplace:approval:error" />}
        {pending ? (
          <ConsentDeltaRows
            delta={pending.consentDelta}
            approvable={fields}
            approved={approved}
            onApprovedChange={(field, checked) => setApproved((current) => ({ ...current, [field]: checked }))}
            disabled={busy}
          />
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="git-marketplace:approval:none">{t("gitMarketplace.approval.none")}</p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" disabled={busy || !pending || !anyChecked} onClick={() => void approve()} data-testid="git-marketplace:approval:approve">
            {t("gitMarketplace.approval.approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
