import { useCallback, useState } from "react";
import { t } from "../../../i18n/runtime.js";
import { formatIpcError } from "../format-ipc-error.js";
import { isIpcErrorResult, type IpcErrorResult } from "../types.js";

/** A resolved IPC promise can still represent a refused write. */
export function requirePersistedResult<T>(result: T): Exclude<T, IpcErrorResult> {
  if (isIpcErrorResult(result)) {
    throw new Error(formatIpcError(result.error, result.message));
  }
  return result as Exclude<T, IpcErrorResult>;
}

/** Keep optimistic controls honest when the host refuses or cannot persist their change. */
export function useSettingsPersistence(onSaved?: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const persist = useCallback(async <T>(
    operation: () => Promise<T>,
    options: { rollback?: () => void } = {},
  ): Promise<Exclude<T, IpcErrorResult> | null> => {
    setPending((value) => value + 1);
    setError(null);
    let result: Exclude<T, IpcErrorResult>;
    try {
      result = requirePersistedResult(await operation());
    } catch (failure) {
      options.rollback?.();
      setError(failure instanceof Error && failure.message ? failure.message : t("useSettingsOrchestration.saveFailed"));
      return null;
    } finally {
      setPending((value) => value - 1);
    }
    onSaved?.();
    return result;
  }, [onSaved]);
  return { error, saving: pending > 0, persist };
}
