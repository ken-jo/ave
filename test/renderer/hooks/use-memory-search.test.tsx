import "../setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeMockAveApi } from "../mock-ave-api.js";
import { useMemorySearch } from "../../../src/ui/renderer/hooks/use-memory-search.js";
import type { AveApi } from "../../../src/ui/renderer/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("useMemorySearch", () => {
  it("loads MEMORY.md into the memory result catalog", async () => {
    const { api } = makeMockAveApi({
      memoryIndex: "# Ave Memory Index\n\n- direct file-backed 기억",
    });
    const { result } = renderHook(() => useMemorySearch(api as unknown as AveApi));

    await waitFor(() => {
      expect(api.memoryGetIndex).toHaveBeenCalled();
      expect(result.current.noteResults.map((note) => note.title)).toContain("메모리 인덱스");
    });
  });

  it("debounce: fires IPC only once after 200 ms idle", async () => {
    vi.useFakeTimers();
    const { api } = makeMockAveApi();
    const { result } = renderHook(() => useMemorySearch(api as unknown as AveApi));

    act(() => { result.current.setQuery("a"); });
    act(() => { result.current.setQuery("ab"); });
    act(() => { result.current.setQuery("abc"); });

    expect(api.memorySearchEntries).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(api.memorySearchEntries).toHaveBeenCalledTimes(1);
    expect(api.memorySearchEntries).toHaveBeenCalledWith("abc");
  });
});
