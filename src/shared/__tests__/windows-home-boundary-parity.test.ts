import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { isWindowsHomeRootRepairable, isWindowsHomeRootSafe, WINDOWS_HOME_BOUNDARY_SOURCE } from "../windows-home-boundary.js";
import { isOwnerOnlyDacl, windowsOwnerRules, type WindowsDaclFacts } from "../windows-path-facts.js";
import { TOOL_TIMEOUT_POLICY } from "../tool-timeout-policy.js";
import { win32SystemBinary } from "../windows-system-path.js";
import { windowsPowerShellEnv } from "../windows-powershell-env.js";

it.runIf(process.platform === "win32")("keeps transaction and native-fact ownership evaluations in agreement", () => {
  const sid = "S-1-5-21-1004336348-11-77-1417";
  const own = `(A;OICI;FA;;;${sid})`;
  const fixtures = [
    { name: "owner-only", sddl: `O:${sid}D:P${own}`, ownerOnly: true, rootSafe: true, rootRepairable: false },
    { name: "inherited Users read", sddl: `O:${sid}D:P${own}(A;OICIID;FR;;;BU)`, ownerOnly: false, rootSafe: true, rootRepairable: false },
    { name: "foreign owner", sddl: `O:S-1-5-18D:P${own}`, ownerOnly: false, rootSafe: false, rootRepairable: false },
    { name: "deny ACE", sddl: `O:${sid}D:P(D;;FR;;;BU)${own}`, ownerOnly: false, rootSafe: false, rootRepairable: false },
    { name: "generic read", sddl: `O:${sid}D:P${own}(A;;GR;;;BU)`, ownerOnly: false, rootSafe: true, rootRepairable: false },
    { name: "generic write", sddl: `O:${sid}D:P${own}(A;;GW;;;BU)`, ownerOnly: false, rootSafe: false, rootRepairable: false },
    { name: "generic all", sddl: `O:${sid}D:P${own}(A;;GA;;;BU)`, ownerOnly: false, rootSafe: false, rootRepairable: false },
    // The root shapes of the narrow repair (native run 2): only the inherited-only profile shape qualifies.
    { name: "inherited only", sddl: `O:${sid}D:(A;OICIID;FA;;;${sid})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`, ownerOnly: false, rootSafe: false, rootRepairable: true },
    { name: "explicit foreign allow", sddl: `O:${sid}D:(A;OICIID;FA;;;${sid})(A;;FR;;;S-1-1-0)`, ownerOnly: false, rootSafe: false, rootRepairable: false },
    { name: "explicit deny", sddl: `O:${sid}D:(D;;FR;;;BU)(A;OICIID;FA;;;${sid})`, ownerOnly: false, rootSafe: false, rootRepairable: false },
    { name: "inherited, other owner", sddl: `O:S-1-5-18D:(A;OICIID;FA;;;${sid})(A;OICIID;FA;;;SY)`, ownerOnly: false, rootSafe: false, rootRepairable: false },
    { name: "inherited, no user entry", sddl: `O:${sid}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`, ownerOnly: false, rootSafe: false, rootRepairable: false },
    { name: "protected with a foreign entry", sddl: `O:${sid}D:P${own}(A;OICI;FA;;;SY)`, ownerOnly: false, rootSafe: false, rootRepairable: false },
  ];
  const script = `$ErrorActionPreference='Stop';
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    $user=[System.Security.Principal.SecurityIdentifier]::new('${sid}');
    $fixtures=ConvertFrom-Json @'
${JSON.stringify(fixtures)}
'@;
    $results=@(foreach ($fixture in $fixtures) {
      $security=[System.Security.AccessControl.DirectorySecurity]::new();
      $security.SetSecurityDescriptorSddlForm($fixture.sddl);
      $raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(),0);
      $aces=@(foreach ($ace in $raw.DiscretionaryAcl) {
        @{ type=[int]$ace.AceType; flags=[int]$ace.AceFlags; mask=[uint32]([int64]$ace.AccessMask -band 0xffffffffL); sid=$ace.SecurityIdentifier.Value }
      });
      @{ owner=$raw.Owner.Value; protected=$security.AreAccessRulesProtected; aces=$aces;
        ownerOnly=[HomeDirectoryDacl]::OwnerOnly($security,$user,$false);
        rootSafe=[HomeDirectoryDacl]::RootSafe($security,$user,$false,${0x1200a9});
        rootRepairable=[HomeDirectoryDacl]::RootRepairable($security,$user) }
    });
    ConvertTo-Json -InputObject @($results) -Depth 6 -Compress`;
  const rows = JSON.parse(execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64"),
  ], { input: script, encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs,
    env: windowsPowerShellEnv(process.env) })) as Array<{
      owner: string; protected: boolean; aces: NonNullable<WindowsDaclFacts["dacl"]>["aces"];
      ownerOnly: boolean; rootSafe: boolean; rootRepairable: boolean;
    }>;
  expect(rows).toHaveLength(fixtures.length);
  rows.forEach((row, index) => {
    const fixture = fixtures[index]!;
    const dacl = { identity: { volumeSerial: "0x0000000000000001", fileId: "0x00000000000000000000000000000001" },
      owner: row.owner, protected: row.protected, nullDacl: false, aces: row.aces };
    const ownerOnly = row.protected && isOwnerOnlyDacl({ ownerSid: row.owner, elevated: false, rules: windowsOwnerRules(dacl) }, sid);
    const rootSafe = isWindowsHomeRootSafe({ dacl, currentUserSid: sid, elevated: false } as WindowsDaclFacts);
    const rootRepairable = isWindowsHomeRootRepairable({ dacl, currentUserSid: sid, elevated: false, exists: true, directory: true,
      reparseTag: 0, attributes: 16 } as WindowsDaclFacts);
    expect({ ownerOnly, rootSafe, rootRepairable }, fixture.name).toEqual({ ownerOnly: row.ownerOnly, rootSafe: row.rootSafe, rootRepairable: row.rootRepairable });
    expect({ ownerOnly, rootSafe, rootRepairable }, fixture.name).toEqual({ ownerOnly: fixture.ownerOnly, rootSafe: fixture.rootSafe, rootRepairable: fixture.rootRepairable });
  });
});
