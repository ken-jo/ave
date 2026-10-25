/** Show the stored value beside the environment override notice; the override decides the running value. */
import { useEffect, useState } from "react";
import { envVarForSettingsPath } from "../../../shared/env-backed-settings.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";

/** The one call this hook makes — so a tab can hand it an injected api. */
export interface EnvForcedSettingsReader {
  envForcedSettings: () => Promise<readonly string[]>;
}

/** Read forced settings from main's environment authority; show no notice until the snapshot arrives. */
export function useEnvForcedSettings(api?: EnvForcedSettingsReader): readonly string[] {
  const [paths, setPaths] = useState<readonly string[]>([]);
  useEffect(() => {
    let alive = true;
    void (api ?? getApi()).envForcedSettings().then((forced) => {
      if (alive) setPaths(forced);
    });
    return () => { alive = false; };
  }, [api]);
  return paths;
}

export interface EnvForcedNoticeProps {
  /** Settings path this notice is about, e.g. `system.corpCaEnabled`. */
  readonly settingsPath: string;
  /** The forced set, from {@link useEnvForcedSettings}. */
  readonly forcedPaths: readonly string[];
  /** i18n key for the sentence; it receives the variable name as `envVar`. */
  readonly messageKey: string;
  readonly testId: string;
  /** Spacing for the surrounding layout — the text styling is not negotiable. */
  readonly className?: string;
}

/** Render the notice, or nothing. Nothing is also the answer when the path is forced but no variable is known for it: a
 * sentence naming an empty variable tells the user less than silence. */
export function EnvForcedNotice({
  settingsPath,
  forcedPaths,
  messageKey,
  testId,
  className,
}: EnvForcedNoticeProps) {
  const { t } = useTranslation();
  if (!forcedPaths.includes(settingsPath)) return null;
  const envVar = envVarForSettingsPath(settingsPath);
  if (!envVar) return null;
  return (
    <p
      className={`text-xs text-muted-foreground${className ? ` ${className}` : ""}`}
      data-testid={testId}
    >
      {t(messageKey, { envVar })}
    </p>
  );
}
