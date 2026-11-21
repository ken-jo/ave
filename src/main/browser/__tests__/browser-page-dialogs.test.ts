import { describe, expect, it } from "vitest";
import { dismissedPageDialogs, withDismissedDialogs } from "../browser-page-dialogs.js";

describe("what a page did while the agent drove it", () => {
  it("adds a started download's file name and latest state to that page's next tool result, once", () => {
    const update = dismissedPageDialogs.noteDownload(41, "report\u0007.pdf", "started", []);
    dismissedPageDialogs.noteDownload(41, "refused.zip", "blocked", []);
    update("completed");
    expect(withDismissedDialogs(42, { done: "click" })).toEqual({ done: "click" });
    expect(withDismissedDialogs(41, { done: "click" })).toEqual({ done: "click", downloads: [{ name: "report.pdf", state: "completed" }, { name: "refused.zip", state: "blocked" }] });
    expect(withDismissedDialogs(41, { done: "click" })).toEqual({ done: "click" });
  });
  it("tells a waiter when a download no result has reported yet ends, and only then", () => {
    let ended = 0;
    const stop = dismissedPageDialogs.onceDownloadSettled(45, () => { ended++; });
    const update = dismissedPageDialogs.noteDownload(45, "late.bin", "started", []);
    expect(ended).toBe(0);
    dismissedPageDialogs.noteDownload(46, "other-page.bin", "completed", []);
    expect(ended).toBe(0);
    update("cancelled");
    expect(ended).toBe(1);
    update("completed");
    expect(ended).toBe(1);
    stop();
    // One that already ended and was not reported answers at once; once reported, a new waiter waits again.
    let now = 0;
    dismissedPageDialogs.onceDownloadSettled(45, () => { now++; });
    expect(now).toBe(1);
    expect(withDismissedDialogs(45, {}).downloads).toEqual([{ name: "late.bin", state: "completed" }]);
    let later = 0;
    const cancel = dismissedPageDialogs.onceDownloadSettled(45, () => { later++; });
    cancel();
    dismissedPageDialogs.noteDownload(45, "refused.bin", "blocked", []);
    expect(later).toBe(0);
    // A page that is gone ends its waiters.
    let gone = 0;
    withDismissedDialogs(45, {});
    dismissedPageDialogs.onceDownloadSettled(45, () => { gone++; });
    dismissedPageDialogs.forget(45);
    expect(gone).toBe(1);
    withDismissedDialogs(46, {});
  });
  it("keeps a bounded number of downloads and forgets a page that is gone", () => {
    for (let count = 0; count < 9; count++) dismissedPageDialogs.noteDownload(43, `file-${count}.bin`, "started", []);
    expect(withDismissedDialogs(43, {}).downloads).toHaveLength(5);
    dismissedPageDialogs.noteDownload(44, "a.bin", "started", []);
    dismissedPageDialogs.forget(44);
    expect(withDismissedDialogs(44, { done: "click" })).toEqual({ done: "click" });
  });
  it("tells a watcher of each recorded download until it stops watching or the page is gone", () => {
    let noted = 0;
    const chains: (readonly string[])[] = [];
    const stop = dismissedPageDialogs.onDownloadNoted(47, (urlChain) => { noted++; chains.push(urlChain); });
    dismissedPageDialogs.noteDownload(47, "a.bin", "started", ["https://site.example/start", "https://site.example/a.bin"]);
    expect(chains).toEqual([["https://site.example/start", "https://site.example/a.bin"]]);
    dismissedPageDialogs.noteDownload(48, "elsewhere.bin", "started", []);
    expect(noted).toBe(1);
    stop();
    dismissedPageDialogs.noteDownload(47, "b.bin", "started", []);
    expect(noted).toBe(1);
    dismissedPageDialogs.onDownloadNoted(47, () => { noted++; });
    dismissedPageDialogs.forget(47);
    dismissedPageDialogs.noteDownload(47, "c.bin", "started", []);
    expect(noted).toBe(1);
    dismissedPageDialogs.forget(47);
    dismissedPageDialogs.forget(48);
  });
});
