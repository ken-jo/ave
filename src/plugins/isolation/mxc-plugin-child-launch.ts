import { MxcProcessContractError } from "../../permissions/mxc-extension-errors.js";
import { isMxcExtensionBackendSelected, prepareMxcHolderStart } from "../../sandbox/wrap-bundled-command.js";
import { resolvePluginHostStorageDir } from "../plugin-storage-layout.js";
import type { DelegatedWorkerConfinement } from "./host-api-dispatcher.js";
import type { MxcPluginChildLaunch } from "./mxc-plugin-child.js";

/** The production planner for a Windows plugin child's container start. It lays out what the MCP and hook holder
 * adapter lays out: a fresh `<runtime root>\staging\<opaque-id>` HOME/temp added to the captured write roots, and the
 * registered holder readiness probe. With no registered probe it throws, and the caller starts nothing. The command,
 * grants, floor pierces and egress owner stay the adapter's; the egress lease is row 2's. */
export async function prepareMxcPluginChildLaunch(intent: {
  readonly pluginId: string;
  readonly command: string;
  /** The plugin's generation root. */
  readonly cwd: string;
  readonly pluginDataDir: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly envelope: DelegatedWorkerConfinement;
}): Promise<MxcPluginChildLaunch> {
  const start = prepareMxcHolderStart({ label: `plugin-child:${intent.pluginId}`, executable: intent.command, baseEnv: intent.baseEnv,
    allowWrite: intent.envelope.write });
  return {
    home: start.home,
    temp: start.temp,
    // The host-only storage beside the data directory is named, so admission refuses any grant reaching it.
    filesystemOwnership: { readRoots: [intent.cwd], writeRoots: [...intent.envelope.write, start.root],
      hostStorageRoots: [resolvePluginHostStorageDir(intent.pluginDataDir)] },
    probe: start.probe,
    // Revocation reaches the child through `assertCurrent` and the envelope registration.
    signal: new AbortController().signal,
    assertCurrent: () => {
      if (!isMxcExtensionBackendSelected()) throw new MxcProcessContractError("Plugin child container backend is no longer selected");
    },
    release: start.release,
  };
}
