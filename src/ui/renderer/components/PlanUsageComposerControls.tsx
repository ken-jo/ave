/**
 * The composer's controls for a subscription runtime that runs on Ave's own request path and spends the user's plan
 * (ChatGPT plan usage): the model speed menu (Instant / Medium / High) and, as its bottom row, "Using ChatGPT plan"
 * with the provider's Manage usage link. The provider's guidelines ask for that notice near the composer or model
 * selector whenever requests use the plan.
 *
 * The speed is a plain LLM preference (`llm.subscriptionReasoningSpeed`); the turn asks the model for that speed's
 * effort, and the model's accepted levels decide what is sent. Each option says when the selected model would run it
 * at another level, so nothing is silently clamped.
 */
import { useEffect, useState } from "react";
import { Check, Gauge } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { useTranslation } from "../../../i18n/react.js";
import { planReasoning } from "../../../engine/llm/reasoning-plan.js";
import {
  DEFAULT_SUBSCRIPTION_REASONING_SPEED,
  SUBSCRIPTION_REASONING_SPEEDS,
  subscriptionReasoningSpeedEffort,
  subscriptionRuntimeDescriptor,
  type SubscriptionChatRuntimeSelection,
  type SubscriptionReasoningSpeed,
} from "../../../shared/subscription-runtime.js";
import { getApi } from "../api-client.js";
import { isIpcErrorResult, type AppSettings } from "../types.js";

const SPEED_LABEL_KEYS: Record<SubscriptionReasoningSpeed, string> = {
  instant: "bottomActionRow.planSpeedInstant",
  medium: "bottomActionRow.planSpeedMedium",
  high: "bottomActionRow.planSpeedHigh",
};

interface PlanComposerState {
  readonly runtime: SubscriptionChatRuntimeSelection;
  readonly speed: SubscriptionReasoningSpeed;
}

/** The selected plan runtime and speed, or null when chat is not on a runtime that offers a speed menu. */
function planComposerState(settings: AppSettings): PlanComposerState | null {
  const runtime = settings.llm.activeChatRuntime;
  if (runtime?.kind !== "subscription") return null;
  if (subscriptionRuntimeDescriptor(runtime.provider).offersReasoningSpeed !== true) return null;
  return { runtime, speed: settings.llm.subscriptionReasoningSpeed ?? DEFAULT_SUBSCRIPTION_REASONING_SPEED };
}

/**
 * What the selected model does with a speed: the effort it runs at, or null when it takes no reasoning setting.
 * The same planner the send path uses, so the menu and the request cannot disagree.
 */
function planSpeedOutcome(
  model: string | undefined,
  speed: SubscriptionReasoningSpeed,
): { readonly effort: string; readonly asked: boolean } | null {
  if (!model) return null;
  const requestedEffort = subscriptionReasoningSpeedEffort(speed);
  const plan = planReasoning({
    vendor: "openai",
    model,
    enableThinking: true,
    budgetTokens: 0,
    requestedEffort,
    request: { hasTools: true },
  });
  if (plan?.kind !== "openai-effort" || plan.effort === undefined) return null;
  return { effort: plan.effort, asked: plan.effort === requestedEffort };
}

export function PlanUsageComposerControls() {
  const { t } = useTranslation();
  const [state, setState] = useState<PlanComposerState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const take = (settings: AppSettings) => {
      if (!cancelled) setState(planComposerState(settings));
    };
    let unsubscribe = () => {};
    try {
      const api = getApi();
      void api.getSettings().then(take).catch(() => { /* the controls stay hidden */ });
      unsubscribe = api.onSettingsUpdated(take);
    } catch {
      // A surface without the renderer api (a preview, a tour fixture) has no runtime to describe: stay hidden.
    }
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  if (!state) return null;
  const descriptor = subscriptionRuntimeDescriptor(state.runtime.provider);
  const model = state.runtime.model;
  const applies = planSpeedOutcome(model, state.speed) !== null;
  const title = t("bottomActionRow.planSpeed");

  const pick = async (speed: SubscriptionReasoningSpeed) => {
    if (speed === state.speed) {
      setOpen(false);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      // The menu closes only once the choice is saved; the broadcast then moves the mark.
      const saved = await getApi().updateSettings({ llm: { subscriptionReasoningSpeed: speed } });
      if (isIpcErrorResult(saved)) {
        console.warn("[ave] model speed pick was refused: %s", saved.error);
        return;
      }
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const manageUsage = () => {
    if (descriptor.usageSettingsUrl) void getApi().openExternalUrl(descriptor.usageSettingsUrl);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="iab-status-plan-speed"
          data-speed={state.speed}
          aria-label={`${t("subscriptionProvidersSection.chatgptPlanInUse")} · ${title}: ${t(SPEED_LABEL_KEYS[state.speed])}`}
          className="inline-flex min-w-0 shrink items-center gap-1 transition-opacity duration-(--motion-fast) ease-(--motion-ease-standard) hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none"
        >
          <Gauge className="h-3 w-3 shrink-0 text-input-bar-placeholder" aria-hidden="true" />
          {/* Always visible while chat spends the plan: the notice the provider asks for, beside the model. */}
          <span className="min-w-0 truncate" data-testid="iab-status-plan-in-use">
            {t("subscriptionProvidersSection.chatgptPlanInUse")}
          </span>
          <span className="shrink-0 opacity-30" aria-hidden="true">·</span>
          <span className={applies ? "shrink-0" : "shrink-0 line-through opacity-60"}>{t(SPEED_LABEL_KEYS[state.speed])}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={6} className="w-72 p-0" data-testid="plan-speed-picker">
        <div className="px-3 pt-3 text-caption font-medium text-muted-foreground">{title}</div>
        <ul className="px-1 py-1" role="listbox" aria-label={title} aria-busy={busy}>
          {SUBSCRIPTION_REASONING_SPEEDS.map((speed) => {
            const current = speed === state.speed;
            const outcome = planSpeedOutcome(model, speed);
            const note = outcome === null
              ? t("bottomActionRow.planSpeedNotApplicable")
              : outcome.asked
                ? null
                : t("bottomActionRow.planSpeedRunsAt", { speed: t(SPEED_LABEL_KEYS[speed]), effort: outcome.effort });
            return (
              <li key={speed} role="option" aria-selected={current}>
                <button
                  type="button"
                  onClick={() => void pick(speed)}
                  disabled={busy}
                  data-testid={`plan-speed-option:${speed}`}
                  className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus:outline-none focus-visible:bg-accent disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{t(SPEED_LABEL_KEYS[speed])}</span>
                    {note ? (
                      <span className="block text-caption text-muted-foreground" data-testid={`plan-speed-note:${speed}`}>
                        {note}
                      </span>
                    ) : null}
                  </span>
                  {current ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div
          className="flex items-center justify-between gap-2 border-t border-border/(--opacity-medium) px-3 py-2 text-sm"
          data-testid="plan-usage-in-use"
        >
          <span className="min-w-0 truncate">{t("subscriptionProvidersSection.chatgptPlanInUse")}</span>
          {descriptor.usageSettingsUrl ? (
            <button
              type="button"
              onClick={manageUsage}
              data-testid="plan-usage-manage"
              className="shrink-0 text-input-bar-action hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus"
            >
              {t("subscriptionProvidersSection.chatgptPlanManageUsage")}
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
