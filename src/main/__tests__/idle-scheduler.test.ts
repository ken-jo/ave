import { describe, it, expect, vi } from "vitest";
import { strict as assert } from "node:assert";

import {
  IdleSchedulerService,
  type IdleState,
  type PowerMonitorLike,
} from "../idle-scheduler.js";

class FakePowerMonitor implements PowerMonitorLike {
  onBatteryPower = false;
  private idleTimeSec = 0;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  setIdleTime(seconds: number): void {
    this.idleTimeSec = seconds;
  }

  getSystemIdleTime(): number {
    return this.idleTimeSec;
  }

  on(event: string, handler: (...args: any[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) this.handlers.delete(event);
    else this.handlers.clear();
    return this;
  }

  removeListener(event: string, handler: (...args: any[]) => void): this {
    const arr = this.handlers.get(event);
    if (!arr) return this;
    const idx = arr.indexOf(handler);
    if (idx >= 0) arr.splice(idx, 1);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    const arr = this.handlers.get(event);
    if (!arr) return;
    for (const h of arr.slice()) h(...args);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

function makeService(
  overrides: { powerMonitor?: FakePowerMonitor } = {},
): {
  sched: IdleSchedulerService;
  pm: FakePowerMonitor;
} {
  const pm = overrides.powerMonitor ?? new FakePowerMonitor();
  const logs: string[] = [];
  const sched = new IdleSchedulerService({

    powerMonitor: pm,
    tickIntervalMs: 1_000_000,

    logger: (m) => logs.push(m),
  });
  return { sched, pm };
}

describe("SECURITY_GATE: IdleSchedulerService 5-state", () => {

  it("case 3: signalKeystroke → IDLE_SCAN에서 THROTTLED 전환", () => {
    const { sched } = makeService();
    sched._testForceTransition("IDLE_SCAN", "test-entry");
    expect(sched.getState()).toBe("IDLE_SCAN");
    sched.signalKeystroke();
    expect(sched.getState()).toBe("THROTTLED");
  });

  it("case 4: signalConversation → IDLE_SCAN에서 RUNNING 전환", () => {
    const { sched } = makeService();
    sched._testForceTransition("IDLE_SCAN", "test-entry");
    sched.signalConversation();
    expect(sched.getState()).toBe("RUNNING");
  });

  it("case 5: _tick이 idle 조건 충족 시 IDLE_SCAN 진입", () => {
    const { sched, pm } = makeService();
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testTick();
    expect(sched.getState()).toBe("IDLE_SCAN");
  });

  it("case 8: transition same-state는 no-op", () => {
    const logs: string[] = [];
    const pm = new FakePowerMonitor();
    const sched = new IdleSchedulerService({

      powerMonitor: pm,
      tickIntervalMs: 1_000_000,
      logger: (m) => logs.push(m),
    });
    sched._testForceTransition("RUNNING", "first");
    const before = logs.length;
    sched._testForceTransition("RUNNING", "second");
    expect(logs.length).toBe(before);
  });

  it("case 9: PAUSED 상태는 _reevaluate 무시", () => {
    const { sched, pm } = makeService();
    sched._testForceTransition("PAUSED", "suspend");
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testReevaluate("force");
    expect(sched.getState()).toBe("PAUSED");
  });

  it("case 10: suspend → PAUSED, resume → RESUME_DELAY", () => {
    const { sched, pm } = makeService();
    sched.start();
    pm.emit("suspend");
    expect(sched.getState()).toBe("PAUSED");
    pm.emit("resume");
    expect(sched.getState()).toBe("RESUME_DELAY");
    sched.stop();
  });

  it("case 11: RESUME_DELAY 타이머 만료 → RUNNING", async () => {
    vi.useFakeTimers();
    const pm = new FakePowerMonitor();
    const sched = new IdleSchedulerService({

      powerMonitor: pm,
      tickIntervalMs: 1_000_000,
      resumeDelayMs: 30,

      logger: () => {},
    });
    try {
      sched.start();
      pm.emit("resume");
      expect(sched.getState()).toBe("RESUME_DELAY");
      await vi.advanceTimersByTimeAsync(60);
      expect(sched.getState()).toBe("RUNNING");
    } finally {
      sched.stop();
      vi.useRealTimers();
    }
  });

  it("case 12: onBattery + IDLE_SCAN → RUNNING 강등", () => {
    const { sched, pm } = makeService();
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testTick();
    expect(sched.getState()).toBe("IDLE_SCAN");
    pm.onBatteryPower = true;
    sched._testReevaluate("battery-switch");
    expect(sched.getState()).toBe("RUNNING");
  });

  it("case 13: CPU spike (cpuEma > 0.7) + IDLE_SCAN → THROTTLED", () => {
    const { sched } = makeService();
    sched._testForceTransition("IDLE_SCAN", "test-case");
    sched._testSetCpuEma(0.85);
    sched._testReevaluate("cpu-spike-force");
    expect(sched.getState()).toBe("THROTTLED");
  });

  it("case 14: getMetrics shape", () => {
    const { sched } = makeService();
    const m = sched.getMetrics();
    expect(m.state).toBe("RUNNING");
    expect(typeof m.cpuEma).toBe("number");
    expect(typeof m.lastConversationAt).toBe("number");
    expect(typeof m.lastKeystrokeAt).toBe("number");
  });

  it("case 15: stop 후 powerMonitor 리스너 해제", () => {
    const pm = new FakePowerMonitor();
    const sched = new IdleSchedulerService({

      powerMonitor: pm,
      tickIntervalMs: 1_000_000,
      logger: () => {},
    });
    sched.start();
    expect(pm.listenerCount("suspend")).toBeGreaterThan(0);
    sched.stop();
    expect(pm.listenerCount("suspend")).toBe(0);
    expect(pm.listenerCount("resume")).toBe(0);
  });

  it("case 16: conversationCooldown 미만이면 IDLE_SCAN 진입 차단", () => {
    const { sched, pm } = makeService();
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testSetLastConversation(Date.now() - 10_000);
    sched._testTick();
    expect(sched.getState()).toBe("RUNNING");
  });

  it("case 19: 전체 전이 시퀀스 RUNNING → IDLE_SCAN → THROTTLED → IDLE_SCAN", () => {
    const { sched, pm } = makeService();
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testTick();
    const seq: IdleState[] = [sched.getState()];
    sched.signalKeystroke();
    seq.push(sched.getState());
    sched._testSetLastConversation(0);
    (sched as unknown as { lastKeystrokeAt: number }).lastKeystrokeAt = Date.now() - 60_000;
    sched._testReevaluate("cooled");
    seq.push(sched.getState());
    assert.deepEqual(seq, ["IDLE_SCAN", "THROTTLED", "IDLE_SCAN"]);
  });

  it("case 20: signalConversation은 RUNNING에서는 state 변경 없음", () => {
    const { sched } = makeService();
    expect(sched.getState()).toBe("RUNNING");
    sched.signalConversation();
    expect(sched.getState()).toBe("RUNNING");
  });

  it("notifies listeners and responds to conversation activity", async () => {
    const pm = new FakePowerMonitor();
    const sched = new IdleSchedulerService({
      powerMonitor: pm,
      tickIntervalMs: 1_000_000,
      logger: () => {},
    });
    const seen: IdleState[] = [];
    sched.addStateChangeListener((state) => seen.push(state));

    // Idle conditions met → IDLE_SCAN; the listener fires for the transition.
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testTick();
    expect(sched.getState()).toBe("IDLE_SCAN");
    expect(seen).toContain("IDLE_SCAN");

    // signalConversation still drives the state machine.
    sched.signalConversation();
    expect(sched.getState()).toBe("RUNNING");
  });
});
