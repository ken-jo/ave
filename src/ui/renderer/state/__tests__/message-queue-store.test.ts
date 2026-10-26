/** See docs/blueprints/composer-redesign-message-queue.md#message-queue-semantics. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueueStore, formatQueueInject } from "../message-queue-store.js";

describe("MessageQueueStore", () => {
  let store: MessageQueueStore;

  beforeEach(() => {
    store = new MessageQueueStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("add 는 item 을 추가하고 size 증가", () => {
    expect(store.size()).toBe(0);
    const item = store.add("first");
    expect(store.size()).toBe(1);
    expect(item.text).toBe("first");
    expect(item.selected).toBe(false);
    expect(item.id).toBeTruthy();
  });

  it("add 는 trim 후 빈 텍스트면 throw", () => {
    expect(() => store.add("")).toThrow(/empty/);
    expect(() => store.add("   ")).toThrow(/empty/);
    expect(() => store.add("\n\t")).toThrow(/empty/);
    expect(store.size()).toBe(0);
  });

  it("add 는 MAX_ITEM_CHARS 초과 시 throw (economic DoS 방어)", () => {
    const huge = "x".repeat(MessageQueueStore.MAX_ITEM_CHARS + 1);
    expect(() => store.add(huge)).toThrow(/exceeds/);
    expect(store.size()).toBe(0);
    // 정확히 limit 까지는 OK
    const atLimit = "x".repeat(MessageQueueStore.MAX_ITEM_CHARS);
    expect(() => store.add(atLimit)).not.toThrow();
    expect(store.size()).toBe(1);
  });

  it("add 는 MAX_ITEMS 초과 시 throw", () => {
    for (let i = 0; i < MessageQueueStore.MAX_ITEMS; i++) {
      store.add(`item-${i}`);
    }
    expect(store.size()).toBe(MessageQueueStore.MAX_ITEMS);
    expect(() => store.add("overflow")).toThrow(/queue full/);
    expect(store.size()).toBe(MessageQueueStore.MAX_ITEMS);
  });

  it("add 는 text 를 trim 해서 저장", () => {
    const item = store.add("  hello  ");
    expect(item.text).toBe("hello");
  });

  it("add 는 listener 호출", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.add("a");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("remove 는 해당 항목만 제거", () => {
    const a = store.add("a");
    store.add("b");
    const c = store.add("c");
    store.remove(a.id);
    const items = store.getItems();
    expect(items.map((it) => it.text)).toEqual(["b", "c"]);
    expect(items.find((it) => it.id === c.id)).toBeDefined();
  });

  it("remove 가 없는 id 면 no-op + listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    store.remove("nonexistent");
    expect(listener).not.toHaveBeenCalled();
    expect(store.size()).toBe(1);
  });

  it("moves a pending item without changing its identity, selection or expiration", () => {
    const first = store.add("first");
    const second = store.add("second");
    store.toggleSelect(second.id);
    const selected = store.getItems()[1];
    const listener = vi.fn();
    store.subscribe(listener);

    store.move(second.id, -1);

    expect(store.getItems()).toEqual([selected, first]);
    expect(store.getItems()[0]).toBe(selected);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.takeSelected()).toEqual([selected]);
  });

  it("does not move beyond the queue or move handed-off items", () => {
    const first = store.add("first");
    const second = store.add("second");
    store.markHandedOff([first.id], "first");
    const before = store.getItems();
    const listener = vi.fn();
    store.subscribe(listener);

    store.move(first.id, -1);
    store.move(second.id, 1);
    store.move(first.id, 1);
    store.move(second.id, -1);
    store.move("missing", 1);

    expect(store.getItems()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("drains pending messages in the reordered order", () => {
    store.add("first");
    const second = store.add("second");
    store.add("third");
    store.move(second.id, -1);
    expect(store.getPending().map((item) => item.text)).toEqual(["second", "first", "third"]);
    expect(store.takeAll().map((item) => item.text)).toEqual(["second", "first", "third"]);
  });

  it("toggleSelect 는 selection 토글", () => {
    const a = store.add("a");
    expect(store.getItems()[0].selected).toBe(false);
    store.toggleSelect(a.id);
    expect(store.getItems()[0].selected).toBe(true);
    store.toggleSelect(a.id);
    expect(store.getItems()[0].selected).toBe(false);
  });

  it("toggleSelect 가 없는 id 면 no-op + listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    store.toggleSelect("nonexistent");
    expect(listener).not.toHaveBeenCalled();
  });

  it("hasSelected / selectedCount 정확", () => {
    const a = store.add("a");
    const b = store.add("b");
    store.add("c");
    expect(store.hasSelected()).toBe(false);
    expect(store.selectedCount()).toBe(0);
    store.toggleSelect(a.id);
    store.toggleSelect(b.id);
    expect(store.hasSelected()).toBe(true);
    expect(store.selectedCount()).toBe(2);
  });

  it("clearSelection 은 모든 선택 해제 (item 은 유지)", () => {
    const a = store.add("a");
    const b = store.add("b");
    store.toggleSelect(a.id);
    store.toggleSelect(b.id);
    store.clearSelection();
    expect(store.size()).toBe(2);
    expect(store.hasSelected()).toBe(false);
  });

  it("clearSelection 은 선택 없을 때 listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    store.clearSelection();
    expect(listener).not.toHaveBeenCalled();
  });

  it("clear 는 큐 전체 비움", () => {
    store.add("a");
    store.add("b");
    store.clear();
    expect(store.size()).toBe(0);
  });

  it("clear 는 빈 큐에서 listener 호출 안 함", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it("takeAll 은 전체 항목 반환 + 큐 비움", () => {
    store.add("a");
    store.add("b");
    store.add("c");
    const taken = store.takeAll();
    expect(taken.map((it) => it.text)).toEqual(["a", "b", "c"]);
    expect(store.size()).toBe(0);
  });

  it("takeAll 은 빈 큐에서 [] 반환 + listener 호출 안 함", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.takeAll()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("takeSelected 는 선택 항목만 꺼냄, 미선택 잔존", () => {
    const a = store.add("a");
    store.add("b");
    const c = store.add("c");
    store.toggleSelect(a.id);
    store.toggleSelect(c.id);
    const taken = store.takeSelected();
    expect(taken.map((it) => it.text)).toEqual(["a", "c"]);
    expect(store.getItems().map((it) => it.text)).toEqual(["b"]);
  });

  it("takeSelected 는 선택 없을 때 [] 반환 + listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.takeSelected()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("takeOne 은 특정 1 항목 꺼냄, 다른 항목 잔존", () => {
    store.add("a");
    const b = store.add("b");
    store.add("c");
    const taken = store.takeOne(b.id);
    expect(taken?.text).toBe("b");
    expect(store.getItems().map((it) => it.text)).toEqual(["a", "c"]);
  });

  it("takeOne 은 없는 id 면 null + listener 호출 안 함", () => {
    store.add("a");
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.takeOne("nonexistent")).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(store.size()).toBe(1);
  });

  it("subscribe 가 unsubscribe 함수 반환", () => {
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.add("a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    store.add("b");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("여러 listener 가 동시 등록 가능", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    store.subscribe(l1);
    store.subscribe(l2);
    store.add("a");
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it("update 는 텍스트 수정 + expiresAt 갱신 + listener 호출", () => {
    const a = store.add("original");
    const oldExpiresAt = store.getItems()[0].expiresAt;
    const listener = vi.fn();
    store.subscribe(listener);
    // 시간 한 ms 진행 후 update
    const result = store.update(a.id, "edited");
    expect(result).toBe(true);
    expect(store.getItems()[0].text).toBe("edited");
    expect(store.getItems()[0].expiresAt).toBeGreaterThanOrEqual(oldExpiresAt);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("update 는 같은 텍스트면 no-op + listener 호출 안 함", () => {
    const a = store.add("foo");
    const listener = vi.fn();
    store.subscribe(listener);
    const result = store.update(a.id, "foo");
    expect(result).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("update 는 빈 텍스트 throw", () => {
    const a = store.add("foo");
    expect(() => store.update(a.id, "")).toThrow(/empty/);
    expect(() => store.update(a.id, "   ")).toThrow(/empty/);
  });

  it("update 는 cap 초과 throw", () => {
    const a = store.add("foo");
    const huge = "x".repeat(MessageQueueStore.MAX_ITEM_CHARS + 1);
    expect(() => store.update(a.id, huge)).toThrow(/exceeds/);
    expect(store.getItems()[0].text).toBe("foo");
  });

  it("update 가 없는 id 면 no-op", () => {
    store.add("foo");
    const listener = vi.fn();
    store.subscribe(listener);
    const result = store.update("nonexistent", "bar");
    expect(result).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("getItems 는 만료된 항목 자동 prune", () => {
    const item = store.add("will expire");
    // 항목의 expiresAt 을 과거로 직접 변형 — store 내부 시점 manipulation 어려우니 vi.setSystemTime 으로 시간 진행.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + MessageQueueStore.DEFAULT_TTL_MS + 1);
    const items = store.getItems();
    expect(items.find((it) => it.id === item.id)).toBeUndefined();
    expect(store.size()).toBe(0);
    vi.useRealTimers();
  });

  it("getItems 는 만료 항목이 없으면 동일 snapshot 참조를 유지", () => {
    store.add("stable");
    const first = store.getItems();
    const second = store.getItems();
    expect(second).toBe(first);
  });

  it("update 시 expiresAt 갱신 — TTL reset", () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);
    const item = store.add("foo");
    const initialExpiresAt = store.getItems()[0].expiresAt;
    vi.setSystemTime(start + MessageQueueStore.DEFAULT_TTL_MS / 2);
    store.update(item.id, "bar");
    const newExpiresAt = store.getItems()[0].expiresAt;
    expect(newExpiresAt).toBeGreaterThan(initialExpiresAt);
    vi.useRealTimers();
  });

  it("listener throw 가 다른 listener 호출 막지 않음 (isolation)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const l1 = vi.fn(() => { throw new Error("listener boom"); });
    const l2 = vi.fn();
    store.subscribe(l1);
    store.subscribe(l2);
    store.add("a");
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("formatQueueInject", () => {
  function makeItem(text: string): {
    id: string; text: string; selected: boolean; createdAt: number; expiresAt: number;
  } {
    return { id: "x", text, selected: false, createdAt: 0, expiresAt: Date.now() + 60_000 };
  }

  it("0 항목 → 빈 문자열", () => {
    expect(formatQueueInject([])).toBe("");
  });

  it("1 항목 → wrap 없이 항목 자체", () => {
    expect(formatQueueInject([makeItem("끝나면 요약해줘")])).toBe("끝나면 요약해줘");
  });

  it("2+ 항목 → wrap + bullet list", () => {
    const result = formatQueueInject([
      makeItem("가사 요약"),
      makeItem("출처 URL"),
      makeItem("노트 정리"),
    ]);
    expect(result).toBe(
      "사용자가 다음 항목을 추가 요청했습니다:\n- 가사 요약\n- 출처 URL\n- 노트 정리"
    );
  });

  it("줄바꿈 포함 항목도 안전하게 wrap", () => {
    const result = formatQueueInject([
      makeItem("first"),
      makeItem("multi\nline"),
    ]);
    expect(result).toContain("- first");
    expect(result).toContain("- multi\nline");
  });
});

describe("MessageQueueStore guide reservation", () => {
  it("locks the reserved batch without claiming acceptance or changing selection and expiration", () => {
    const store = new MessageQueueStore();
    const first = store.add("first");
    const second = store.add("second");
    store.toggleSelect(first.id);
    const reservation = store.reservePending()!;
    expect(reservation.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(store.getPending()).toEqual([]);
    expect(store.getItems()[0]).toMatchObject({ selected: true, expiresAt: first.expiresAt });
    expect(store.getItems().every((item) => item.handedOffAs === undefined)).toBe(true);

    store.move(second.id, -1);
    expect(store.update(first.id, "edited")).toBe(false);
    store.remove(first.id);
    store.toggleSelect(first.id);
    expect(store.takeOne(first.id)).toBeNull();
    expect(store.takeSelected()).toEqual([]);
    expect(store.takeAll()).toEqual([]);
    expect(store.getItems().map((item) => item.text)).toEqual(["first", "second"]);
    expect(store.getItems()[0].selected).toBe(true);

    store.settleReservation(reservation.id);
    expect(store.getPending().map((item) => item.text)).toEqual(["first", "second"]);
    expect(store.takeSelected().map((item) => item.text)).toEqual(["first"]);
  });

  it("settles only its own batch and keeps accepted rows until delivery or release", () => {
    const store = new MessageQueueStore();
    store.add("first");
    const first = store.reservePending()!;
    store.add("second");
    const second = store.reservePending()!;
    store.settleReservation(first.id, "first");
    store.settleReservation("wrong-owner");
    expect(store.getItems()[0].handedOffAs).toBe("first");
    expect(store.getItems()[1].handoffReservationId).toBe(second.id);
    expect(store.takeAll()).toEqual([]);
    store.settleReservation(second.id);
    expect(store.getPending().map((item) => item.text)).toEqual(["second"]);
    store.clearDelivered("first");
    expect(store.getItems().map((item) => item.text)).toEqual(["second"]);
  });

  it("cannot claim a replacement queue and does not revive expired reservations", () => {
    vi.useFakeTimers();
    try {
      const store = new MessageQueueStore();
      store.add("old");
      const old = store.reservePending()!;
      store.clear();
      store.add("new");
      const current = store.reservePending()!;
      store.settleReservation(old.id, "old");
      expect(store.getItems()[0].handoffReservationId).toBe(current.id);
      vi.advanceTimersByTime(MessageQueueStore.DEFAULT_TTL_MS + 1);
      store.settleReservation(current.id, "new");
      expect(store.getItems()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MessageQueueStore selection during handoff", () => {
  it("clears only available selection while preserving reserved selection for a denied request", () => {
    const store = new MessageQueueStore();
    const reserved = store.add("reserved");
    store.toggleSelect(reserved.id);
    const reservation = store.reservePending()!;
    const pending = store.add("pending");
    store.toggleSelect(pending.id);
    expect(store.selectedCount()).toBe(1);
    store.clearSelection();
    expect(store.getItems().map((item) => item.selected)).toEqual([true, false]);
    expect(store.hasSelected()).toBe(false);
    store.settleReservation(reservation.id);
    expect(store.selectedCount()).toBe(1);
    expect(store.takeSelected().map((item) => item.text)).toEqual(["reserved"]);
  });
});
