import { vi } from "vitest";
import type { MemoryReviewerService } from "../memory-reviewer-service.js";

type MemoryReviewer = Pick<MemoryReviewerService, "review">;

export function createMemoryReviewer(implementation: MemoryReviewer["review"]) {
  return {
    review: vi.fn<MemoryReviewer["review"]>(implementation),
  };
}
