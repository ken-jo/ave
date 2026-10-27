import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isXlsxPanelEditRequest, XLSX_EDIT_LIMITS, type XlsxCellValue,
  type XlsxPanelEditRequest, type XlsxPanelEditResult } from "../shared/xlsx-panel-edit.js";
import type { PreviewTableSheet } from "../shared/preview-document.js";
import type { SandboxActionDirectory } from "../permissions/sandbox-action-directory.js";
import { publishWorkbookEdit, type WorkbookFileSnapshot } from "../skills/xlsx-file-transaction.js";
import { readPreviewDocumentInput, readPreviewDocumentSnapshot } from "../tools/preview-document-input.js";

interface DocumentBinding {
  token: string;
  owner: string;
  path: string;
  snapshot: WorkbookFileSnapshot;
  sheet: PreviewTableSheet;
  approved: boolean;
  saved: boolean;
  isCurrent: () => boolean;
  observe: (invalidate: () => void) => () => void;
  stop: () => void;
  controller: AbortController;
}
interface SavedContinuation { path: string; sheet: number; snapshot: WorkbookFileSnapshot }
interface WorkbookRuntime {
  run: (directory: string, operation: "edit" | "inspect", signal?: AbortSignal) => Promise<{ stdout: string }>;
  checkAvailable: () => void | Promise<void>;
}

function sameSnapshot(left: WorkbookFileSnapshot, right: WorkbookFileSnapshot): boolean {
  return (["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "nlink"] as const)
    .every((key) => left.identity[key] === right.identity[key]) && left.data.equals(right.data);
}
function failure(error: Extract<XlsxPanelEditResult, { ok: false }>["error"]): never {
  throw Object.assign(new Error(error), { panelCode: error });
}
function cellAddress(row: number, column: number): string {
  let letters = "";
  for (let index = column + 1; index > 0; index = Math.floor((index - 1) / 26)) {
    letters = String.fromCharCode(65 + (index - 1) % 26) + letters;
  }
  return `${letters}${row + 1}`;
}

/** A read identity becomes mutation authority only after native consent for that exact binding. */
export class XlsxPanelEditService {
  private readonly bindings = new Map<string, DocumentBinding>();
  private readonly owners = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly continuations = new Map<string, SavedContinuation>();
  private readonly readContinuations = new Map<string, { revision: number; saved: SavedContinuation }>();
  private active = false;

  constructor(private readonly runtime: WorkbookRuntime = {
    run: async (...args) => (await import("./bundled-script-execution.js")).runWorkbookScript(...args),
    checkAvailable: async () => (await import("./bundled-script-execution.js")).assertWorkbookScriptAvailable(),
  }) {}

  beginRead(owner: string): number {
    const old = this.bindings.get(this.owners.get(owner) ?? "");
    this.drop(old);
    const revision = (this.revisions.get(owner) ?? 0) + 1;
    this.revisions.set(owner, revision);
    const saved = this.continuations.get(owner);
    this.continuations.delete(owner);
    this.readContinuations.delete(owner);
    if (saved) this.readContinuations.set(owner, { revision, saved });
    return revision;
  }

  finishRead(owner: string, revision: number): void {
    if (this.readContinuations.get(owner)?.revision === revision) this.readContinuations.delete(owner);
  }

  invalidate(owner: string): void {
    this.drop(this.bindings.get(this.owners.get(owner) ?? ""));
    this.continuations.delete(owner);
    this.readContinuations.delete(owner);
    this.revisions.set(owner, (this.revisions.get(owner) ?? 0) + 1);
  }

  bind(owner: string, revision: number, path: string, snapshot: WorkbookFileSnapshot, sheet: PreviewTableSheet,
    isCurrent: () => boolean, observe: DocumentBinding["observe"]): { editToken: string; editEnabled: boolean } | undefined {
    if (this.revisions.get(owner) !== revision || !isCurrent()) return undefined;
    const pending = this.readContinuations.get(owner);
    const continuation = pending?.revision === revision ? pending.saved : undefined;
    this.readContinuations.delete(owner);
    const approved = continuation !== undefined && continuation.path === path && continuation.sheet === sheet.index
      && sameSnapshot(continuation.snapshot, snapshot);
    const token = randomBytes(32).toString("hex");
    const binding: DocumentBinding = { token, owner, path, snapshot, sheet, approved, saved: false, isCurrent, observe,
      stop: () => {}, controller: new AbortController() };
    this.bindings.set(token, binding);
    this.owners.set(owner, token);
    binding.stop = observe(() => { if (this.bindings.get(token) === binding) this.invalidate(owner); });
    if (!isCurrent()) { this.invalidate(owner); return undefined; }
    return { editToken: token, editEnabled: approved };
  }

  private drop(binding: DocumentBinding | undefined): void {
    if (!binding) return;
    this.bindings.delete(binding.token);
    if (this.owners.get(binding.owner) === binding.token) this.owners.delete(binding.owner);
    binding.controller.abort();
    binding.stop();
  }

  private assertCurrent(binding: DocumentBinding): void {
    if (this.bindings.get(binding.token) !== binding || !binding.isCurrent() || binding.controller.signal.aborted) failure("expired");
  }

  private async assertUnchanged(binding: DocumentBinding): Promise<void> {
    this.assertCurrent(binding);
    try {
      const current = await readPreviewDocumentSnapshot(binding.path, binding.controller.signal);
      this.assertCurrent(binding);
      if (!sameSnapshot(binding.snapshot, current)) failure("stale-file");
    } catch (error) {
      this.assertCurrent(binding);
      if ((error as { panelCode?: string }).panelCode === "stale-file") throw error;
      failure("stale-file");
    }
  }

  async handle(owner: string, raw: unknown, confirm: (path: string) => Promise<boolean>): Promise<XlsxPanelEditResult> {
    if (!isXlsxPanelEditRequest(raw)) return { ok: false, error: "invalid-request" };
    const request: XlsxPanelEditRequest = raw;
    const binding = this.bindings.get(request.token);
    if (request.action === "release") {
      if (binding?.owner === owner) this.invalidate(owner);
      return { ok: true, action: "release" };
    }
    if (!binding || binding.owner !== owner || binding.saved) return { ok: false, error: "expired" };
    if (this.active) return { ok: false, error: "busy" };
    this.active = true;
    let directory: string | undefined;
    let staging: SandboxActionDirectory | undefined;
    let cleanupUnproven = false;
    try {
      this.assertCurrent(binding);
      await this.runtime.checkAvailable();
      await this.assertUnchanged(binding);
      if (request.action === "enable") {
        if (!binding.approved) {
          const approved = await confirm(binding.path);
          this.assertCurrent(binding);
          if (!approved) failure("permission-denied");
          await this.assertUnchanged(binding);
          binding.approved = true;
        }
        return { ok: true, action: "enable" };
      }
      if (!binding.approved) failure("permission-denied");
      const sheet = binding.sheet;
      if (request.row < sheet.firstRow || request.row >= sheet.firstRow + sheet.rows.length
        || request.column < sheet.firstColumn || request.column >= sheet.firstColumn + (sheet.rows[0]?.length ?? 0)) failure("unsupported-cell");
      staging = (await import("../permissions/sandbox-action-directory.js")).createSandboxActionDirectory();
      directory = staging.path;
      this.assertCurrent(binding);
      const workbook = join(directory, "workbook.xlsx");
      const requestPath = join(directory, "request.json");
      await fs.writeFile(workbook, binding.snapshot.data, { flag: "wx", mode: 0o600 });
      const cell = cellAddress(request.row, request.column);
      await fs.writeFile(requestPath, JSON.stringify(request.action === "cell" ? { sheet: sheet.index, cell }
        : { sheet: sheet.index, edits: [{ cell, value: request.value }] }), { flag: "wx", mode: 0o600 });
      this.assertCurrent(binding);
      const result = await this.runtime.run(directory, request.action === "cell" ? "inspect" : "edit", binding.controller.signal);
      this.assertCurrent(binding);
      const response: unknown = JSON.parse(result.stdout);
      if (!response || typeof response !== "object" || Array.isArray(response)) failure("edit-failed");
      const record = response as Record<string, unknown>;
      if (request.action === "cell") {
        if (Object.keys(record).length !== 2 || typeof record.formula !== "boolean"
          || !isXlsxPanelEditRequest({ action: "save", token: request.token, row: request.row, column: request.column, value: record.value })) failure("unsupported-cell");
        await this.assertUnchanged(binding);
        return { ok: true, action: "cell", value: record.value as XlsxCellValue, formula: record.formula };
      }
      const backup = binding.snapshot.data.length > XLSX_EDIT_LIMITS.backupBytes;
      if (Object.keys(record).length !== 3 || record.editedCells !== 1 || record.needsRecalculation !== true
        || record.backup !== (backup ? `${workbook}.ave-bak` : null)) failure("edit-failed");
      if (backup) {
        const recovered = await readPreviewDocumentInput(`${workbook}.ave-bak`, binding.controller.signal);
        if (!recovered.equals(binding.snapshot.data)) failure("edit-failed");
      }
      const output = await readPreviewDocumentInput(workbook, binding.controller.signal);
      // Validate the fixed output through the same confined parser before giving it host publication authority.
      await fs.unlink(requestPath);
      await fs.writeFile(requestPath, JSON.stringify({ sheet: sheet.index, cell }), { flag: "wx", mode: 0o600 });
      const inspected = JSON.parse((await this.runtime.run(directory, "inspect", binding.controller.signal)).stdout) as unknown;
      if (!inspected || typeof inspected !== "object" || Array.isArray(inspected)
        || Object.keys(inspected).length !== 2 || !("value" in inspected) || !("formula" in inspected)
        || inspected.formula !== false || inspected.value !== request.value) failure("edit-failed");
      if (!(await readPreviewDocumentInput(workbook, binding.controller.signal)).equals(output)) failure("edit-failed");
      await this.assertUnchanged(binding);
      publishWorkbookEdit(binding.path, binding.snapshot, output, 1, { assertCurrent: () => this.assertCurrent(binding) });
      // Publication is the commit point. A later refresh failure must not turn this into a retryable failed save.
      binding.saved = true;
      this.continuations.delete(owner);
      try {
        const snapshot = await readPreviewDocumentSnapshot(binding.path);
        if (snapshot.data.equals(output) && binding.isCurrent() && this.bindings.get(binding.token) === binding) {
          this.continuations.set(owner, { path: binding.path, sheet: sheet.index, snapshot });
        }
      } catch { /* A committed save can still require a fresh explicit reload and consent. */ }
      return { ok: true, action: "save" };
    } catch (error) {
      cleanupUnproven = (error as { cleanupUnproven?: boolean }).cleanupUnproven === true;
      const code = (error as { panelCode?: Extract<XlsxPanelEditResult, { ok: false }>["error"]; code?: string }).panelCode;
      if (code) {
        if ((code === "stale-file" || code === "expired") && this.bindings.get(binding.token) === binding) this.invalidate(owner);
        return { ok: false, error: code };
      }
      if ((error as { code?: string }).code === "ESTALE") {
        if (this.bindings.get(binding.token) === binding) this.invalidate(owner);
        return { ok: false, error: "stale-file" };
      }
      if ((error as { code?: string }).code === "EEXIST") return { ok: false, error: "backup-exists" };
      if ((error as Error).name === "BundledScriptExecutionError") return { ok: false,
        error: ["unavailable", "integrity"].includes((error as { code: string }).code) ? "edit-unavailable"
          : request.action === "cell" ? "unsupported-cell" : "edit-failed" };
      return { ok: false, error: "edit-failed" };
    } finally {
      try { if (!cleanupUnproven) staging?.cleanup(); }
      catch { console.warn("Workbook staging cleanup failed"); }
      finally { this.active = false; }
    }
  }
}
