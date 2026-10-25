import { tempRoutinesStore } from "../routines-fixture.js";

export function withRoutinesStore(
  run: (fixture: Omit<ReturnType<typeof tempRoutinesStore>, "cleanup">) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const { cleanup, ...fixture } = tempRoutinesStore();
    try {
      await run(fixture);
    } finally {
      await cleanup();
    }
  };
}
