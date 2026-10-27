import type { StaticArgvProof } from "./shell-argument-grammar.js";

// Only host preparation binds an already parsed, single command to an image.
// Default string analysis never receives this authority.
const proofs = new WeakMap<object, StaticArgvProof>();
export function bindVerifiedArgvProof(command: object, proof: StaticArgvProof): void { proofs.set(command, proof); }
export function verifiedArgvProof(command: object): StaticArgvProof | undefined { return proofs.get(command); }
export type VerifiedArgvResolver = (argv: readonly (string | undefined)[], raw: readonly string[]) => StaticArgvProof | undefined;
