import "../main/bare-program-lookup.js";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  ImagePreparationBytesRequestSchema,
  ImagePreparationPosixFileRequestSchema,
  ImagePreparationRequestSchema,
} from "../shared/image-preparation-policy.js";
import { normalizeImage } from "./image-preparation-core.js";
import { errorMessage } from "../shared/error-message.js";
import { readImageInput } from "./image-preparation-input.js";
import { ensureFileAccess } from "./file-access-policy.js";
import { adoptHostResources } from "../main/host-resources.js";
import { admitLocalRoute, localFs, withLocalityDecision } from "../shared/local-path-io.js";
import { TargetIdentityChangedError } from "../permissions/target-seal.js";

async function readBoundedStdin(expectedBytes: number): Promise<Buffer> {
  // Allocate bounded input once; chunk collection plus concatenation would double peak source memory.
  const input = Buffer.allocUnsafe(expectedBytes);
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.byteLength > expectedBytes - total) {
      throw new Error("image-input-limit: Decoder stdin exceeds its declared byte budget.");
    }
    bytes.copy(input, total);
    total += bytes.byteLength;
  }
  if (total !== expectedBytes) {
    throw new Error(`invalid-image: Decoder stdin length mismatch (expected ${expectedBytes}, received ${total}).`);
  }
  return input;
}

// Native admission finds its helper through the host resources, so a decoder started without them reads nothing.
function adoptParentHostResources(): boolean {
  try {
    adoptHostResources(JSON.parse(process.argv[3] ?? "null"));
    return true;
  } catch {
    return false;
  }
}

if (!adoptParentHostResources()) {
  process.stdout.write(JSON.stringify({ ok: false, error: "image-processing-unavailable: host-resources-unavailable: The decoder was started without the host resources." }));
  process.exitCode = 1;
} else {
  try {
    const raw: unknown = JSON.parse(process.argv[2] ?? "{}");
    const bytesRequest = ImagePreparationBytesRequestSchema.safeParse(raw);
    if (bytesRequest.success) {
      const bytes = await readBoundedStdin(bytesRequest.data.inputBytes);
      process.stdout.write(JSON.stringify({
        ok: true,
        image: await normalizeImage(bytes, bytesRequest.data.options),
      }));
    } else {
      const schema = process.platform === "win32" ? ImagePreparationRequestSchema
        : ImagePreparationRequestSchema.or(ImagePreparationPosixFileRequestSchema);
      const request = schema.parse(raw);
      if (!isAbsolute(request.path) || !isAbsolute(request.scope.cwd)) throw new Error("invalid-image-path: Image source and read scope must be absolute.");
      const requireAuthorizedPath = (real: string): string => {
        if ("expectedPath" in request && real !== request.expectedPath) throw new TargetIdentityChangedError();
        // Check policy on both names before opening the authorized file.
        const context = { ...request.scope, metadata: {} };
        const denied = ensureFileAccess(request.path, context, "read") ?? ensureFileAccess(real, context, "read");
        if (denied) throw new Error(denied.output);
        return real;
      };
      const judged = process.platform === "win32" ? withLocalityDecision(() => {
        return requireAuthorizedPath(localFs.realpathNative(admitLocalRoute(request.path).verdict));
      }) : requireAuthorizedPath(await realpath(request.path));
      const bytes = await readImageInput(judged, new AbortController().signal);
      process.stdout.write(JSON.stringify({ ok: true, image: await normalizeImage(bytes, request.options) }));
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: `invalid-image: ${errorMessage(error).slice(0, 2048)}` }));
    process.exitCode = 1;
  }
}
