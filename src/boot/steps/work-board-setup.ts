import { WorkflowTemplateStore } from "../../main/workflow-template-store.js";
/** Migrate before loading the store; main starts the scanner after IPC and plugins are ready. */
import { WorkBoardStore } from "../../main/work-board-store.js";
import { migrateLegacyPluginBoardToWorkBoard } from "./work-board-migration.js";
import { seedSampleWorkBoard } from "../../work-board/sample-data.js";
import { scanAndRaiseDueSoon, startDueSoonScans } from "../../work-board/due-soon.js";
import { ALERT_HOST_PLUGIN_ID } from "../../shared/alerts-types.js";
import { createDirStorage, type WorkBoardStorage } from "../../work-board/storage.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { createLogger } from "../../lib/logger.js";
import { t } from "../../i18n/index.js";
import type { BootContext } from "../context.js";

const log = createLogger("ave");

const LEGACY_BOARD_NOTICE_FILE = "legacy-board-notice.json";

/** Once per home, on the desktop: the legacy boards the migration left as they are, and where they are. */
export async function noticeLegacyBoardKept(
  paths: readonly string[],
  ctx: Pick<BootContext, "host" | "notificationService">,
  marker: Pick<WorkBoardStorage, "readJson" | "writeJson">,
): Promise<void> {
  if (!ctx.host.desktop || (await marker.readJson(LEGACY_BOARD_NOTICE_FILE)) !== null) return;
  const delivery = ctx.notificationService.deliver({
    kind: "system",
    title: t("be_workBoard.legacyBoardKeptTitle"),
    body: t("be_workBoard.legacyBoardKept", { path: paths.join(", ") }),
    // Boot can precede the renderer's toast subscription.
    bypassFocusGate: true,
  });
  if (delivery?.accepted) await marker.writeJson(LEGACY_BOARD_NOTICE_FILE, { noticedAt: new Date().toISOString() });
}

export async function setupWorkBoard(ctx: BootContext): Promise<void> {
  const workBoardStorage = createDirStorage(openFeatureNamespace("work-board").dir);
  let keptBoards: readonly string[] = [];
  const workBoardMigrated = await migrateLegacyPluginBoardToWorkBoard((paths) => { keptBoards = paths; });
  if (keptBoards.length > 0) {
    await noticeLegacyBoardKept(keptBoards, ctx, workBoardStorage).catch((err) =>
      log.warn("boot: legacy work-board notice not shown (non-fatal): %s", (err as Error).message));
  }
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

  // Seed labeled samples once, only for an empty, unmigrated board.
  await seedSampleWorkBoard({
    store: workBoardStore,
    marker: workBoardStorage,
    alreadyMigrated: workBoardMigrated,
    now: Date.now,
  }).catch((err) =>
    log.warn("boot: work-board sample seed failed (non-fatal): %s", (err as Error).message),
  );

  ctx.workflowTemplateStore = new WorkflowTemplateStore();
  ctx.workBoardStore = workBoardStore;
  ctx.workBoardStorage = workBoardStorage;
  // Defer initial scanning until IPC is wired; shutdown owns the timer.
  ctx.startWorkBoardDueSoon = () => {
    ctx.stopWorkBoardDueSoon = startDueSoonScans(
      () => scanAndRaiseDueSoon(workBoardStore, Date.now(),
        (input) => ctx.alertsService.raise(ALERT_HOST_PLUGIN_ID, input)),
      (err) => log.warn("work-board: due_soon scan failed (non-fatal): %s", (err as Error).message),
    );
  };
}
