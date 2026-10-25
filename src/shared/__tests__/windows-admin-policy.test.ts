import { describe, expect, it } from "vitest";
import { windowsPolicyTrustFailure, type WindowsPolicyDescriptor } from "../windows-admin-policy.js";

const ADMINISTRATORS = "S-1-5-32-544";
const SYSTEM = "S-1-5-18";
const USER = "S-1-5-21-100-200-300-1001";
const INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

function descriptor(ownerSid = ADMINISTRATORS, sid = ADMINISTRATORS, mask = 0x1f01ff): WindowsPolicyDescriptor {
  return { ownerSid, nullDacl: false, rules: [{ sid, mask, allow: true, inheritOnly: false }] };
}

describe("Windows policy descriptor trust", () => {
  it("requires an administrative file owner while allowing trusted system writers", () => {
    expect(windowsPolicyTrustFailure(descriptor(), descriptor())).toBeNull();
    expect(windowsPolicyTrustFailure(descriptor(SYSTEM, INSTALLER), descriptor(INSTALLER))).toBeNull();
    expect(windowsPolicyTrustFailure(descriptor(USER), descriptor())).toBe(`owner ${USER}`);
    expect(windowsPolicyTrustFailure(descriptor(INSTALLER), descriptor())).toBe(`owner ${INSTALLER}`);
  });

  it("rejects every file mutation right for an untrusted principal", () => {
    for (const mask of [2, 4, 16, 256, 65536, 262144, 524288, 0x10000000, 0x40000000]) {
      expect(windowsPolicyTrustFailure(descriptor(ADMINISTRATORS, USER, mask), descriptor())).toBe(`file writable by ${USER}`);
    }
    expect(windowsPolicyTrustFailure(descriptor(ADMINISTRATORS, USER, 0x120089), descriptor())).toBeNull();
  });

  it("rejects every parent mutation right and an untrusted parent owner", () => {
    for (const mask of [64, 65536, 262144, 524288, 0x10000000, 0x40000000]) {
      expect(windowsPolicyTrustFailure(descriptor(), descriptor(ADMINISTRATORS, USER, mask))).toBe(`parent writable by ${USER}`);
    }
    expect(windowsPolicyTrustFailure(descriptor(), descriptor(USER))).toBe(`parent owner ${USER}`);
  });

  it("accepts the add-file grant a default ProgramData folder inherits on the parent", () => {
    expect(windowsPolicyTrustFailure(descriptor(), descriptor(ADMINISTRATORS, USER, 0x116))).toBeNull();
  });

  it("rejects null DACLs and does not let a deny hide an unsafe allow", () => {
    const file = descriptor();
    file.nullDacl = true;
    expect(windowsPolicyTrustFailure(file, descriptor())).toBe("file has an unrestricted DACL");
    expect(windowsPolicyTrustFailure(descriptor(), file)).toBe("parent has an unrestricted DACL");
    file.nullDacl = false;
    file.rules = [{ sid: USER, mask: 2, allow: false, inheritOnly: false }, { sid: USER, mask: 2, allow: true, inheritOnly: false }];
    expect(windowsPolicyTrustFailure(file, descriptor())).toBe(`file writable by ${USER}`);
    file.rules[1]!.inheritOnly = true;
    expect(windowsPolicyTrustFailure(file, descriptor())).toBeNull();
  });
});
