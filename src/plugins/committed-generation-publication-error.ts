import type { PublishedPluginGenerationTransition } from "./plugin-generation-coordinator.js";
import type { CommittedPluginGeneration } from "./plugin-host-generation.js";

/**
 * How far in-process publication got once the durable commit succeeded:
 * `published` — the pointer names the generation and a later publication
 * step failed; `withheld` — the pointer never moved (the host was shutting
 * down), so the committed generation is staged and starts on the next launch.
 */
export type CommittedPluginGenerationPublication = "published" | "withheld";

/** A generation committed durably but failed synchronous in-process publication. */
export class CommittedPluginGenerationPublicationError<T = unknown> extends Error {
  readonly code = "PLUGIN_GENERATION_PUBLICATION_FAILED_AFTER_COMMIT";
  readonly outcome:
    | Readonly<{ state: "active"; generationId: string }>
    | Readonly<{ state: "inactive" }>;

  constructor(
    readonly pluginId: string,
    readonly generationId: string | undefined,
    readonly publicationCause: unknown,
    readonly transition: PublishedPluginGenerationTransition,
    readonly committed?: CommittedPluginGeneration<T>,
    readonly publication: CommittedPluginGenerationPublication = "published",
  ) {
    super(
      publication === "withheld"
        ? `plugin '${pluginId}' generation '${generationId ?? "unknown"}' was committed durably but not published; it starts on the next launch`
        : generationId
          ? `plugin '${pluginId}' generation '${generationId}' publication failed after durable commit`
          : `plugin '${pluginId}' inactive generation publication failed after durable commit`,
      { cause: publicationCause },
    );
    this.name = "CommittedPluginGenerationPublicationError";
    this.outcome = generationId && publication === "published"
      ? Object.freeze({ state: "active", generationId })
      : Object.freeze({ state: "inactive" });
  }

  withCommitted<TResult>(
    committed: CommittedPluginGeneration<TResult>,
  ): CommittedPluginGenerationPublicationError<TResult> {
    return new CommittedPluginGenerationPublicationError(
      this.pluginId,
      this.generationId,
      this.publicationCause,
      this.transition,
      committed,
      this.publication,
    );
  }
}

export function isCommittedPluginGenerationPublicationError(
  error: unknown,
): error is CommittedPluginGenerationPublicationError {
  return error instanceof CommittedPluginGenerationPublicationError;
}
