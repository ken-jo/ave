import variant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";

const LINEAR_MEMORY_PAGE_BYTES = 64 * 1024;

export interface WorkbookWorkspace {
  readonly memory: WebAssembly.Memory;
  readonly context: QuickJSContext;
  readonly runtime: QuickJSRuntime;
  readonly deadline: number;
  dispose(): void;
}

/** Values and array buffers use the same maximum linear memory, without host capabilities. */
export async function openWorkbookWorkspace(): Promise<WorkbookWorkspace> {
  const limits = PREVIEW_DOCUMENT_LIMITS;
  const deadline = Date.now() + limits.parseTimeoutMs;
  const memory = new WebAssembly.Memory({
    initial: limits.initialWorkbookMemoryBytes / LINEAR_MEMORY_PAGE_BYTES,
    maximum: limits.maxWorkbookMemoryBytes / LINEAR_MEMORY_PAGE_BYTES,
  });
  const module = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: memory }));
  if (module.getWasmMemory() !== memory) throw new Error("Workbook workspace memory was not installed.");
  const runtime = module.newRuntime();
  try {
    runtime.setMemoryLimit(limits.maxWorkbookHeapBytes);
    runtime.setMaxStackSize(limits.maxWorkbookStackBytes);
    runtime.setInterruptHandler(() => Date.now() >= deadline);
    const context = runtime.newContext();
    return { memory, runtime, context, deadline, dispose() { context.dispose(); runtime.dispose(); } };
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}
