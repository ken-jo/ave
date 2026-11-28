import { describe, expect, it } from "vitest";
import { fileIdentityKey, probeBirthTimes, reportedBirthTimeNs, sameFileIdentity, type FileIdentity } from "../file-identity.js";

describe("exact file identity", () => {
  const original = { dev: 7n, ino: 2n ** 60n };

  it("refuses adjacent identifiers beyond numeric precision", () => {
    const replaced = { ...original, ino: original.ino + 1n };
    expect(Number(original.ino)).toBe(Number(replaced.ino));
    expect(sameFileIdentity(original, replaced)).toBe(false);
    expect(fileIdentityKey(original)).not.toBe(fileIdentityKey(replaced));
  });

  it("accepts equal exact identifiers", () => {
    expect(sameFileIdentity(original, { ...original })).toBe(true);
    expect(fileIdentityKey(original)).toBe("7:1152921504606846976");
  });

  it("refuses identifiers on different devices", () => {
    expect(sameFileIdentity(original, { ...original, dev: 8n })).toBe(false);
    expect(fileIdentityKey(original)).not.toBe(fileIdentityKey({ ...original, dev: 8n }));
  });

  it("never treats legacy numeric identifiers as exact", () => {
    const legacy = { dev: 7, ino: Number(original.ino) } as unknown as FileIdentity;
    expect(sameFileIdentity(legacy, legacy)).toBe(false);
    expect(sameFileIdentity(original, legacy)).toBe(false);
    expect(() => fileIdentityKey(legacy)).toThrow("bigint identifiers");
  });
});

// The birth time joins a Linux folder's identity only where it is the host's own (review #758, re-verify P3).

describe("birth times in a folder's identity", () => {
  function host(birthFollowsChange: boolean, clockMoves = true) {
    let ctime = 1_000n;
    const birth = 1_000n;
    return {
      stat: () => ({ ctimeNs: ctime, birthtimeNs: birthFollowsChange ? ctime : birth }),
      touch: () => { if (clockMoves) ctime += 4_000_000n; },
      wait: () => {},
    };
  }

  it("trusts a birth time that stays when the change time moves", () => {
    const { stat, touch, wait } = host(false);
    expect(probeBirthTimes(stat, touch, wait)).toBe(true);
  });

  it("refuses a birth time that follows the change time, as libuv reports it without statx", () => {
    const { stat, touch, wait } = host(true);
    expect(probeBirthTimes(stat, touch, wait)).toBe(false);
  });

  it("refuses when the change time never moved, and when no birth time is reported", () => {
    const { stat, touch, wait } = host(false, false);
    expect(probeBirthTimes(stat, touch, wait)).toBe(false);
    expect(probeBirthTimes(() => ({ ctimeNs: 1n, birthtimeNs: 0n }), () => {}, () => {})).toBe(false);
  });

  it("gives no birth for a filesystem that reports none", () => {
    expect(reportedBirthTimeNs({ ctimeNs: 5n, birthtimeNs: 0n })).toBeUndefined();
  });

  // On a host with statx (every CI and development host here) the real probe trusts the birth time.
  it.runIf(process.platform === "linux" || process.platform === "darwin")("keeps a real host's birth time", () => {
    expect(reportedBirthTimeNs({ ctimeNs: 5n, birthtimeNs: 7n })).toBe(7n);
  });
});
