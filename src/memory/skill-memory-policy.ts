import { Buffer } from "node:buffer";
import { z } from "zod";
import { modelBoundCredentialKind, maskSensitiveData, scrubSecretsForLLM } from "../shared/dlp.js";

export const SKILL_MEMORY_COMPLETION_LIMIT = 3;
export const SKILL_MEMORY_SCOPE_LIMIT = 100;
const DESCRIPTION_LIMIT = 120;
const BODY_BYTE_LIMIT = 2_000;
const EVIDENCE_BYTE_LIMIT = 4_000;
const REVIEW_BYTE_LIMIT = 12_000;
const RESERVED_STRUCTURE = /[<>\u2028\u2029]|\x60|~~~|!?\[[^\]\n]+\]\([^\n]+\)|\*\*[^\n]+\*\*|\bave[-_:]|^\s*(?:#{1,6}\s|>|\[\w+\]:)/imu;

export interface SkillMemoryEvidence {
  id: string;
  text: string;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ")
    .split("\n").map(line => line.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")).join("\n").trim();
}

function containsSensitiveText(value: string): boolean {
  return modelBoundCredentialKind(value) !== null
    || maskSensitiveData(value).detections.length > 0 || scrubSecretsForLLM(value) !== value;
}

export function sanitizeSkillMemoryText(description: string, body: string) {
  const normalizedDescription = normalizeText(description).replace(/\s+/gu, " ");
  const normalizedBody = normalizeText(body);
  if (!normalizedDescription || !normalizedBody || [...normalizedDescription].length > DESCRIPTION_LIMIT
    || Buffer.byteLength(normalizedBody) > BODY_BYTE_LIMIT) return null;
  const combined = `${normalizedDescription}\n${normalizedBody}`;
  if (RESERVED_STRUCTURE.test(combined) || containsSensitiveText(combined)) return null;
  return { description: normalizedDescription, body: normalizedBody };
}

export function approveSkillMemoryEvidence(input: { id: string; input: unknown; verified: boolean; tainted: boolean; skillCommand?: string }): SkillMemoryEvidence | null {
  if (!input.verified || input.tainted || typeof input.input !== "string" || Buffer.byteLength(input.input) > EVIDENCE_BYTE_LIMIT) return null;
  const command = input.skillCommand;
  const [selector] = input.input.split(/\s/u, 1);
  const raw = command && selector === `/${command}` ? input.input.slice(selector.length) : input.input;
  const text = normalizeText(raw);
  if (!text || text.startsWith("/") || RESERVED_STRUCTURE.test(text) || containsSensitiveText(text)) return null;
  return { id: input.id, text };
}

const ProposalSchema = z.object({
  skill: z.string().max(64),
  anchor: z.string().max(128),
  description: z.string().max(DESCRIPTION_LIMIT * 4),
  body: z.string().max(BODY_BYTE_LIMIT * 2),
}).strict();

export function parseSkillMemoryReview(raw: string, evidence: readonly SkillMemoryEvidence[], skills: ReadonlySet<string>) {
  if (Buffer.byteLength(raw) > REVIEW_BYTE_LIMIT) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu, "$1")); } catch { return null; }
  const result = z.array(z.unknown()).max(SKILL_MEMORY_COMPLETION_LIMIT).safeParse(parsed);
  if (!result.success) return null;
  const output: z.infer<typeof ProposalSchema>[] = [];
  for (const item of result.data) {
    const parsedProposal = ProposalSchema.safeParse(item);
    if (!parsedProposal.success) continue;
    const proposal = parsedProposal.data;
    const source = evidence.find(anchor => anchor.id === proposal.anchor);
    const lesson = sanitizeSkillMemoryText(proposal.description, proposal.body);
    if (!skills.has(proposal.skill) || !source || !lesson || !source.text.includes(lesson.body)
      || !lesson.body.replace(/\s+/gu, " ").includes(lesson.description)) continue;
    output.push({ skill: proposal.skill, anchor: proposal.anchor, ...lesson });
  }
  return output;
}
