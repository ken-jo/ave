import { isAbsolute, join } from "node:path";
import { lstatSync } from "node:fs";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { SHA256_HEX } from "../lib/hex-digest-equal.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { openFeatureNamespace } from "../main/storage/feature-namespace.js";
import { assertAveHomeInputWritable, readAveHomeInputSync } from "../shared/ave-home-trust.js";
import { approveSkillMemoryEvidence } from "./skill-memory-policy.js";

const FILENAME = "pending.json";
const RETAINED_ROWS = 128;
const JOURNAL_BYTES = 4 * 1024 * 1024;
const Hash = z.string().regex(SHA256_HEX);
const Id = z.string().min(1).max(128);
const Path = z.string().max(4096).refine(isAbsolute);
const WorkBoardOwnerInput = z.object({
  itemId: z.number().int().positive(),
  projectRoot: Path,
  detailDigest: Hash,
  anchor: z.object({ id: Id, text: z.string().max(4_000) }).strict(),
}).strict();
const Evidence = z.object({
  sessionId: Id,
  projectRoot: Path,
  runKind: z.enum(["attended", "headless", "scheduled"]),
  anchor: WorkBoardOwnerInput.shape.anchor,
  bindings: z.array(z.object({
    id: Hash, skill: Id, projectRoot: Path, filePath: Path, fingerprint: Hash, approval: Hash, projectIdentity: Hash,
  }).strict()).min(1).max(8),
  completionId: Id.optional(),
  started: z.literal(true).optional(),
  routineId: Id.optional(),
  routineDigest: Hash.optional(),
  workBoardItemId: z.number().int().positive().optional(),
}).strict();
const Pending = z.object({
  version: z.literal(1),
  rows: z.array(z.unknown()).max(RETAINED_ROWS),
  board: z.array(z.unknown()).max(RETAINED_ROWS),
}).strict();

export type PendingSkillEvidence = z.infer<typeof Evidence>;
type WorkBoardSkillOwnerInput = z.infer<typeof WorkBoardOwnerInput>;
type Journal = { version: 1; rows: PendingSkillEvidence[]; board: WorkBoardSkillOwnerInput[] };

function verifiedText(anchor: PendingSkillEvidence["anchor"]): boolean {
  return approveSkillMemoryEvidence({ id: anchor.id, input: anchor.text, verified: true, tainted: false })?.text === anchor.text;
}

export class SkillMemoryPending {
  private readonly namespace = openFeatureNamespace("skill-memory");

  read(): Journal {
    const directory = lstatSync(this.namespace.dir, { throwIfNoEntry: false });
    if (directory && !directory.isDirectory()) throw new Error("Invalid pending skill evidence directory");
    const file = join(this.namespace.dir, FILENAME);
    const input = readAveHomeInputSync(file, { requireRegularFile: true });
    if (input.status === "absent") return { version: 1, rows: [], board: [] };
    if (input.status !== "trusted") throw new Error("Pending skill evidence is unreadable");
    const parsed = Pending.parse(JSON.parse(input.bytes.toString("utf8")));
    return {
      version: 1,
      rows: parsed.rows.flatMap(row => {
        const result = Evidence.safeParse(row);
        return result.success && verifiedText(result.data.anchor) ? [result.data] : [];
      }),
      board: parsed.board.flatMap(row => {
        const result = WorkBoardOwnerInput.safeParse(row);
        return result.success && verifiedText(result.data.anchor) ? [result.data] : [];
      }),
    };
  }

  update(change: (journal: Journal) => boolean): Promise<boolean> {
    const file = join(this.namespace.dir, FILENAME);
    return withInProcessFileQueue(file, async () => {
      const journal = this.read();
      if (!change(journal)) return false;
      assertAveHomeInputWritable(file, "update pending skill evidence");
      journal.board = journal.board.slice(-RETAINED_ROWS);
      while (journal.rows.length > RETAINED_ROWS || Buffer.byteLength(JSON.stringify(journal, null, 2)) >= JOURNAL_BYTES) {
        const parked = journal.rows.findIndex(row => row.completionId === undefined);
        if (journal.rows.length) journal.rows.splice(parked === -1 ? 0 : parked, 1);
        else journal.board.shift();
      }
      await this.namespace.writeJson(FILENAME, journal);
      return true;
    });
  }
}
