import "../../../../test/renderer/setup.js";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { makeMockAveApi } from "../../../../test/renderer/mock-ave-api.js";
import { NoticeLiveRegion } from "../components/StatusBar.js";
import { useWindowNotices } from "../hooks/use-window-notices.js";
import type { NotificationHistory } from "../notification-history.js";
import type { AveApi } from "../types.js";

function WindowNoticeVoice({ api, onReady }: { api: AveApi; onReady: (history: NotificationHistory) => void }) {
  const notices = useWindowNotices(api);
  useEffect(() => onReady(notices.history), [onReady, notices.history]);
  return <NoticeLiveRegion toast={notices.latestPolite} errorToast={notices.latestError} />;
}

function mountVoice() {
  const { api } = makeMockAveApi();
  let history: NotificationHistory | undefined;
  render(<WindowNoticeVoice api={api as unknown as AveApi} onReady={(value) => { history = value; }} />);
  if (!history) throw new Error("Missing window history");
  return history;
}

describe("window announcement batches", () => {
  it.each(["error", "info"] as const)("commits every batched %s message to its stable live region", (severity) => {
    const history = mountVoice();
    const region = screen.getByTestId(severity === "error" ? "notice-live-assertive" : "notice-live-polite");
    act(() => {
      history.push({ severity, message: "Failure A" });
      history.push({ severity, message: "Failure B" });
    });
    expect(history.getSnapshot()).toHaveLength(2);
    expect(region).toHaveTextContent("Failure A");
    expect(region).toHaveTextContent("Failure B");
    expect(screen.getByTestId(severity === "error" ? "notice-live-assertive" : "notice-live-polite")).toBe(region);
    act(() => { history.push({ severity, message: "Later C" }); });
    expect(region).toHaveTextContent("Later C");
    expect(region).not.toHaveTextContent("Failure A");
    expect(region).not.toHaveTextContent("Failure B");
  });

  it("announces mixed bursts without dropping messages evicted from visible history", () => {
    const history = mountVoice();
    act(() => {
      for (let index = 0; index < 60; index++) history.push({ severity: index % 2 ? "error" : "success", message: `Arrival ${index}.` });
    });
    expect(history.getSnapshot()).toHaveLength(50);
    const assertive = screen.getByTestId("notice-live-assertive");
    const polite = screen.getByTestId("notice-live-polite");
    for (let index = 0; index < 60; index++) {
      expect(index % 2 ? assertive : polite).toHaveTextContent(`Arrival ${index}.`);
      expect(index % 2 ? polite : assertive).not.toHaveTextContent(`Arrival ${index}.`);
    }
  });
});
