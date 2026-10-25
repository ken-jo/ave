/** Build fixture payloads with the real install-result producer to catch producer/consumer field drift. */
import "../../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  IncompatibleAppVersionError,
  INCOMPATIBLE_APP_VERSION_CODE,
} from "../../../../../plugins/public-contract.js";
import { buildInstallFailureResult } from "../../../../../shared/plugin-install-result.js";
import {
  ProcessEntryRequiresPinnedArtifactError,
  ProcessEntryUnconfinedError,
} from "../../../../../plugins/process-entry.js";
import type { PluginInstallResultPayload } from "../../../../../contract/app-contract.js";
import type { AveApi } from "../../../types.js";
import { useStatusBarInstall } from "../use-status-bar-install.js";

function toastCopyFor(payload: PluginInstallResultPayload): string {
  let deliver: ((p: PluginInstallResultPayload) => void) | null = null;
  const api = {
    onPluginInstallResult: (h: (p: PluginInstallResultPayload) => void) => {
      deliver = h;
      return () => { deliver = null; };
    },
  } as unknown as AveApi;

  const upserts: Array<{ severity: string; message: string }> = [];
  renderHook(() =>
    useStatusBarInstall({
      api,
      pushToast: () => "",
      upsertToast: (_id, input) => {
        upserts.push(input);
        return "";
      },
    }));

  expect(deliver, "hook did not subscribe to the install-result channel").not.toBeNull();
  act(() => { deliver!(payload); });

  const last = upserts.at(-1);
  expect(last?.severity).toBe("error");
  return last?.message ?? "";
}

const APP_VERSION_FAILURE = () =>
  buildInstallFailureResult(
    "sample",
    new IncompatibleAppVersionError("9.9.9", "1.0.0"),
    "addPlugin failed",
  );

describe("install-result payload", () => {
  it("carries the app-version code and its detail as separate fields", () => {
    const payload = APP_VERSION_FAILURE();

    expect(payload.slug).toBe("sample");
    expect(payload.success).toBe(false);
    expect(payload.error).toBe(INCOMPATIBLE_APP_VERSION_CODE);
    // The versions must survive as the detail half, not be collapsed away.
    expect(payload.message).toContain("9.9.9");
    expect(payload.message).toContain("1.0.0");
  });

  it("shows localized copy for an app-version failure, never the bare IPC code", () => {
    expect(toastCopyFor(APP_VERSION_FAILURE()))
      .not.toContain(INCOMPATIBLE_APP_VERSION_CODE);
  });

  it("shows an unrecognised failure's own text", () => {
    const payload = buildInstallFailureResult(
      "sample",
      new Error("disk full"),
      "addPlugin failed",
    );

    expect(payload.error).toBe("disk full");
    expect(payload.message).toBeUndefined();
    expect(toastCopyFor(payload)).toContain("disk full");
  });

  it("keeps both process-entry refusals typed and localizes the install toast", () => {
    const unpinned = buildInstallFailureResult("process-kit", new ProcessEntryRequiresPinnedArtifactError(), "addPlugin failed");
    expect(unpinned.error).toBe("process-entry-requires-pinned-artifact");
    expect(toastCopyFor(unpinned)).toContain("이 사본은 거부되었습니다. 릴리스를 고정한 마켓플레이스에서 설치하세요.");
    const unconfined = buildInstallFailureResult("process-kit", new ProcessEntryUnconfinedError(), "addPlugin failed");
    expect(unconfined.error).toBe("process-entry-unconfined");
    expect(toastCopyFor(unconfined)).toContain("OS 도구 샌드박스 안에서만 실행합니다");
  });

  it("falls back to the caller's message when the failure carries no text", () => {
    const payload = buildInstallFailureResult("sample", {}, "addPlugin failed");

    expect(payload.error).toBe("addPlugin failed");
    expect(toastCopyFor(payload)).toContain("addPlugin failed");
  });

  it("never emits the preparing flag two consumers used to declare", () => {
    for (const failure of [
      new IncompatibleAppVersionError("9.9.9", "1.0.0"),
      new Error("disk full"),
      {},
    ]) {
      const payload = buildInstallFailureResult("sample", failure, "addPlugin failed");
      expect(Object.keys(payload)).not.toContain("preparing");
    }
  });

  it("subscribes through the same bridge method the preload exposes", () => {
    const onPluginInstallResult = vi.fn(() => () => undefined);
    renderHook(() =>
      useStatusBarInstall({
        api: { onPluginInstallResult } as unknown as AveApi,
        pushToast: () => "",
        upsertToast: () => "",
      }));

    expect(onPluginInstallResult).toHaveBeenCalledOnce();
  });
});
