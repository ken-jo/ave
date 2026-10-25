import type { GenericMessage } from "./llm/types.js";
import { buildToolResultStrippedStub, buildToolResultTruncatedStub } from "../shared/tool-result-stub.js";
import type { ToolOutputArtifactInfo } from "../shared/tool-output-artifact.js";
import type { ToolResultArtifactUnavailableInfo } from "../shared/tool-result-stub.js";

/** Size-cap stubs retain paging guidance; -1 counts mean scans skipped at the hard byte ceiling.
 * Sanitize tool names defensively so weakened registration validation cannot permit stub injection. */
function buildToolResultTruncatedStubForWire(
  toolUseId: string,
  toolName: string | undefined,
  info: NonNullable<GenericMessage["meta"]>["truncated"],
  content: string,
  outputArtifact?: ToolOutputArtifactInfo,
  artifactUnavailable?: ToolResultArtifactUnavailableInfo,
  outputArtifactUnavailable?: boolean,
): string {
  return buildToolResultTruncatedStub(toolUseId, toolName, info, content, { outputArtifact, artifactUnavailable, outputArtifactUnavailable });
}

// Compaction, size caps, and artifacts all replace tool-result content on wire.
function toolResultIsMarkedForWireStub(meta: NonNullable<GenericMessage["meta"]>): boolean {
  return meta.compactedAt !== undefined
    || meta.truncated !== undefined
    || meta.outputArtifact !== undefined
    || meta.outputArtifactUnavailable === true;
}

// False when wire serialization stubs a row or its content is already a persisted stub.
export function toolResultContentReachesWire(meta: GenericMessage["meta"]): boolean {
  if (meta === undefined) return true;
  return !toolResultIsMarkedForWireStub(meta) && meta.serializedStub !== true;
}

export function prepareMarkedToolResultsForWire(messages: GenericMessage[]): GenericMessage[] {
  let firstEligibleIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool_result") continue;
    if (msg.meta === undefined) continue;
    firstEligibleIdx = i;
    break;
  }
  if (firstEligibleIdx === -1) return messages;

  const out: GenericMessage[] = messages.slice(0, firstEligibleIdx);
  for (let i = firstEligibleIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool_result" || msg.meta === undefined) {
      out.push(msg);
      continue;
    }

    const marked = toolResultIsMarkedForWireStub(msg.meta);
    if (marked && msg.meta.serializedStub !== true) {
      // Oversized previews retain retrieval paths after compaction; other stale results use shorter stubs.
      const compactedResultText = msg.meta.truncated !== undefined || (msg.meta.outputArtifact !== undefined || msg.meta.outputArtifactUnavailable === true)
        ? buildToolResultTruncatedStubForWire(
          msg.toolUseId, msg.toolName, msg.meta.truncated, msg.content, msg.meta.outputArtifact, msg.meta.artifactUnavailable, msg.meta.outputArtifactUnavailable,
        )
        : buildToolResultStrippedStub(msg.toolName, msg.content.length);
      out.push({
        role: "tool_result",
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        isError: msg.isError,
        content: compactedResultText,
      } as GenericMessage);
    } else {
      // Exclude host-only tool metadata from both request projection and provider payloads.
      const { meta: _meta, ...wireMessage } = msg;
      out.push(wireMessage);
    }
  }
  return out;
}
