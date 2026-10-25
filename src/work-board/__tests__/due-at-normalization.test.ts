/** Migrate only legacy fixed-zone picker midnights; retain the selected civil day rather than its shifted display instant. */
import { describe, it, expect } from "vitest";
import { withTz } from "../../__tests__/test-helpers.js";
import { normalizeBoardDueDates, normalizeDueAt } from "../board-file.js";
import { localDateKey, localDayStart } from "../../shared/local-date.js";
import type { WorkItem } from "../../shared/work-board-types.js";

const KST_MIDNIGHT_JUN16 = "2026-06-16T00:00:00+09:00";

describe("normalizeDueAt", () => {
  it("keeps the picked day on a host west of where it was stamped", () => {
    withTz("America/Los_Angeles", () => {
      // The legacy instant displays as the previous day west of its fixed zone.
      expect(localDateKey(new Date(KST_MIDNIGHT_JUN16))).toBe("2026-06-15");

      const normalized = normalizeDueAt(KST_MIDNIGHT_JUN16);
      expect(localDateKey(new Date(normalized))).toBe("2026-06-16");
      expect(normalized).toBe("2026-06-16T07:00:00.000Z");
    });
  });

  it("leaves a due date that carries a real time of day alone", () => {
    withTz("America/Los_Angeles", () => {
      const withTime = "2026-06-16T14:30:00+09:00";
      expect(normalizeDueAt(withTime)).toBe(withTime);
    });
  });

  it("leaves a value already anchored to the host's own offset alone", () => {
    withTz("Asia/Seoul", () => {
      expect(normalizeDueAt(KST_MIDNIGHT_JUN16)).toBe(KST_MIDNIGHT_JUN16);
    });
  });

  it("leaves a value with no explicit offset alone", () => {
    withTz("America/Los_Angeles", () => {
      expect(normalizeDueAt("2026-06-16T00:00:00")).toBe("2026-06-16T00:00:00");
    });
  });

  it("leaves an unparseable value alone", () => {
    withTz("UTC", () => {
      expect(normalizeDueAt("not-a-date+09:00")).toBe("not-a-date+09:00");
    });
  });

  it("never touches a value this code wrote, so the day survives host hopping", () => {
    // Never re-anchor current Z timestamps; multi-zone round trips would move their stored day repeatedly.
    const seeded = withTz("UTC", () => localDayStart("2026-06-16")!.toISOString());
    expect(seeded).toBe("2026-06-16T00:00:00.000Z");

    const afterSeoul = withTz("Asia/Seoul", () => normalizeDueAt(seeded));
    expect(afterSeoul).toBe(seeded);

    withTz("UTC", () => {
      expect(localDateKey(new Date(afterSeoul))).toBe("2026-06-16");
    });
  });

  it("still migrates the legacy +09:00 stamp in every zone", () => {
    for (const zone of ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London"]) {
      withTz(zone, () => {
        const migrated = normalizeDueAt(KST_MIDNIGHT_JUN16);
        expect(migrated).not.toBe(KST_MIDNIGHT_JUN16);
        expect(migrated).toBe(localDayStart("2026-06-16")!.toISOString());
        expect(localDateKey(new Date(migrated))).toBe("2026-06-16");
      });
    }
    withTz("Asia/Seoul", () => {
      expect(normalizeDueAt(KST_MIDNIGHT_JUN16)).toBe(KST_MIDNIGHT_JUN16);
    });
  });

  it("is idempotent — a second pass moves nothing", () => {
    for (const zone of ["America/Los_Angeles", "Asia/Seoul", "UTC", "Europe/London"]) {
      withTz(zone, () => {
        const once = normalizeDueAt(KST_MIDNIGHT_JUN16);
        expect(normalizeDueAt(once)).toBe(once);
        expect(localDateKey(new Date(once))).toBe("2026-06-16");
      });
    }
  });
});

describe("normalizeBoardDueDates", () => {
  function item(id: number, due_at?: string): WorkItem {
    return {
      id,
      title: `item ${id}`,
      status: "planned",
      priority: "medium",
      created_at: "2026-06-16T01:00:00.000Z",
      updated_at: "2026-06-16T01:00:00.000Z",
      ...(due_at === undefined ? {} : { due_at }),
    };
  }

  it("counts only the rows it actually moved", () => {
    withTz("America/Los_Angeles", () => {
      const { items, changed } = normalizeBoardDueDates([
        item(1, KST_MIDNIGHT_JUN16),
        item(2, "2026-06-16T14:30:00+09:00"),
        item(3),
      ]);

      expect(changed).toBe(1);
      expect(localDateKey(new Date(items[0].due_at as string))).toBe("2026-06-16");
      expect(items[1].due_at).toBe("2026-06-16T14:30:00+09:00");
      expect(items[2].due_at).toBeUndefined();
    });
  });

  it("reports nothing to do on a host in the zone the rows were stamped in", () => {
    withTz("Asia/Seoul", () => {
      const { changed } = normalizeBoardDueDates([item(1, KST_MIDNIGHT_JUN16)]);
      expect(changed).toBe(0);
    });
  });
});
