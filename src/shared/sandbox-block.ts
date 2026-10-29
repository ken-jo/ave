/** Host-private evidence of a filesystem denial observed for this exact command. */
export interface SandboxBlock {
  readonly command: string;
  readonly cwd: string;
}

const issuedBlocks = new WeakSet<object>();
const resultBlocks = new WeakMap<object, SandboxBlock>();

export function issueFilesystemSandboxBlock(command: string, cwd: string): SandboxBlock {
  const block = Object.freeze({ command, cwd });
  issuedBlocks.add(block);
  return block;
}

/** Attach by object identity; neither serialization nor an object spread carries this evidence. */
export function attachSandboxBlock(result: object, block: SandboxBlock): void {
  if (!issuedBlocks.has(block)) throw new Error("Sandbox block was not issued by the host");
  resultBlocks.set(result, block);
}

export function sandboxBlockForResult(result: object): SandboxBlock | undefined {
  return resultBlocks.get(result);
}
