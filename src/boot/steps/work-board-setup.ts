/** Migrate before loading the store; main starts the scanner after IPC and plugins are ready. */
import { WorkBoardStore } from "../../main/work-board-store.js";
import { migrateLegacyPluginBoardToWorkBoard } from "./work-board-migration.js";
import { seedSampleWorkBoard } from "../../work-board/sample-data.js";
import { scanAndEmitDueSoon } from "../../work-board/due-soon.js";
import { ALERT_HOST_PLUGIN_ID } from "../../shared/alerts-types.js";
import { createDirStorage } from "../../work-board/storage.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { emitEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("ave");

export async function setupWorkBoard(ctx: BootContext): Promise<void> {
  const workBoardMigrated = await migrateLegacyPluginBoardToWorkBoard();
  const workBoardStore = new WorkBoardStore();
  await workBoardStore.load().catch((err) => {
    log.warn("boot: work-board load failed (non-fatal): %s", (err as Error).message);
  });
  // Reset persisted active runs with no in-flight execution so interrupted items can run again.
  await workBoardStore
    .reconcileInterruptedRuns()
    .catch((err) =>
      log.warn("boot: work-board run reconcile failed (non-fatal): %s", (err as Error).message),
    );

  const workBoardStorage = createDirStorage(openFeatureNamespace("work-board").dir);

  // Seed labeled samples once, only for an empty, unmigrated board.
  await seedSampleWorkBoard({
    store: workBoardStore,
    marker: workBoardStorage,
    alreadyMigrated: workBoardMigrated,
    now: Date.now,
  }).catch((err) =>
    log.warn("boot: work-board sample seed failed (non-fatal): %s", (err as Error).message),
  );

  const DUE_SOON_TICK_MS = 60 * 60_000;
  const runDueSoonScan = (): void => {
    void scanAndEmitDueSoon(workBoardStore, workBoardStorage, emitEvent, Date.now(),
      (input) => ctx.alertsService.raise(ALERT_HOST_PLUGIN_ID, input))
      .then((fired) => {
        if (fired.length) log.info("work-board: emitted %d due_soon nudge(s)", fired.length);
      })
      .catch((err) =>
        log.warn("work-board: due_soon scan failed (non-fatal): %s", (err as Error).message),
      );
  };

  ctx.workBoardStore = workBoardStore;
  ctx.workBoardStorage = workBoardStorage;
  // Defer initial scanning until IPC is wired; shutdown owns the timer.
  ctx.startWorkBoardDueSoon = () => {
    runDueSoonScan();
    ctx.dueSoonTimer = setInterval(runDueSoonScan, DUE_SOON_TICK_MS);
  };
}
