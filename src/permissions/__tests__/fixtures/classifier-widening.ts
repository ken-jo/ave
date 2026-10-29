// Classification inputs only: the battery does not execute these commands.
// The repository fixture is ordinary metadata; installation controls image proof.
interface WideningFixture {
  readonly command: string;
  readonly installation: boolean;
  readonly storable?: false; // Omitted means the raw exact rule is used.
  readonly plan: boolean; // Host-issued command handle is available.
  readonly exact: boolean; // The approval card offers the original exact rule.
  readonly sandbox: "allow" | "ask"; // No saved grant, foreground confinement.
  readonly saved: "allow" | "ask"; // Saved exact grant, both confinement modes.
  readonly headless: "allow" | "deny"; // Saved exact grant, both confinement modes.
}
const EVALUATION = { installation: true, plan: true, exact: true, sandbox: "allow", saved: "allow", headless: "allow" } as const;
const READ_ONLY = { installation: true, plan: true, exact: true, sandbox: "allow", saved: "allow", headless: "allow" } as const;
const UNPROVEN = { installation: true, plan: false, exact: false, sandbox: "allow", saved: "allow", headless: "allow" } as const;

// Representative regressions, not the complete argument grammar.
// Verdicts and exact eligibility are fixed policy expectations, not analysis output.
export const CLASSIFIER_WIDENING_FIXTURES: readonly WideningFixture[] = [
  { ...READ_ONLY, command: "git log" },
  { ...READ_ONLY, command: "git log --oneline -n 2" },
  { ...READ_ONLY, command: "git log 'HEAD'" },
  { ...READ_ONLY, command: "git show --no-patch HEAD" },
  { ...READ_ONLY, command: "git diff --name-only HEAD main" },
  { ...READ_ONLY, command: "git diff HEAD main --name-status" },
  { ...READ_ONLY, command: "git diff --raw HEAD main" },
  { ...READ_ONLY, command: "git rev-parse --verify HEAD" },
  { ...READ_ONLY, command: "git rev-parse --show-toplevel" },
  { ...READ_ONLY, command: "git branch --list" },
  { ...EVALUATION, command: "bash --noprofile --norc -p -c 'printf ready'" },
  { ...EVALUATION, command: "bash --noprofile --norc -p -c 'cat ~/.ssh/id_rsa'" },
  { ...UNPROVEN, command: "git status" },
  { ...UNPROVEN, command: "git diff" },
  { ...UNPROVEN, command: "git diff HEAD" },
  { ...UNPROVEN, command: "git diff --cached" },
  { ...UNPROVEN, command: "git diff --cached --name-only" },
  { ...UNPROVEN, command: "git diff --cached --name-status" },
  { ...UNPROVEN, command: "git diff --cached --raw" },
  { ...UNPROVEN, command: "git diff --staged --name-only" },
  { ...UNPROVEN, command: "git diff --staged --name-status" },
  { ...UNPROVEN, command: "git diff --staged --raw" },
  { ...UNPROVEN, command: "git diff --cached --stat" },
  { ...UNPROVEN, command: "git show HEAD" },
  { ...UNPROVEN, command: "git log --ext-diff" },
  { ...UNPROVEN, command: "git show --no-patch --textconv HEAD" },
  { ...UNPROVEN, command: "git log --show-signature" },
  { ...UNPROVEN, command: "git log '--format=%G?'" },
  { ...UNPROVEN, command: "git branch --list --sort=signature:grade" },
  { ...UNPROVEN, command: "git -c core.fsmonitor=marker log" },
  { ...UNPROVEN, command: "git --config-env=core.fsmonitor=MARKER log" },
  { ...UNPROVEN, command: "git --exec-path=bin log" },
  { ...UNPROVEN, command: "git --git-dir=other log" },
  { ...UNPROVEN, command: "git --work-tree=other log" },
  { ...UNPROVEN, command: "git -C .. log", sandbox: "ask", saved: "ask", headless: "deny" },
  { ...UNPROVEN, command: "git -C . log" },
  { ...UNPROVEN, command: "git --paginate log" },
  { ...UNPROVEN, command: "git alias-name" },
  { ...UNPROVEN, command: "env git log" },
  { ...UNPROVEN, command: "git log | cat", storable: false },
  { ...UNPROVEN, command: "git log; git log", storable: false },
  { ...UNPROVEN, command: "git log > output.txt", storable: false },
  { ...UNPROVEN, command: "git log --alternate-refs" },
  { ...UNPROVEN, command: "git log '.ssh/config'" },
  { ...UNPROVEN, command: "git diff --cached --name-only --recurse-submodules" },
  { ...UNPROVEN, command: "python3 -I -S ordinary.py" },
  { ...UNPROVEN, command: "env python3 -I -S ordinary.py" },
  { ...UNPROVEN, command: "./bin/python3 -I -S ordinary.py" },
  { ...UNPROVEN, command: "bash -c 'printf ready'" },
  { ...UNPROVEN, command: "bash --noprofile --norc -c 'printf ready'" },
  { ...UNPROVEN, command: "bash --noprofile --norc -p -c '$runtime' extra" },
  { ...UNPROVEN, command: "fish -N --command 'printf ready'" },
  { ...UNPROVEN, command: "node --no-addons -e 'console.log(1)'" },
  { ...UNPROVEN, command: "pwsh -NoProfile -File ordinary.ps1" },
  { ...UNPROVEN, command: "pwsh -File - -enc P" },
  { ...UNPROVEN, command: "pwsh '\u0085-enc\u0085' P" },
  { ...UNPROVEN, command: "zsh -f -c 'printf ready'" },
  { ...UNPROVEN, command: "git log", installation: false },
  { ...UNPROVEN, command: "bash --noprofile --norc -p -c 'printf ready'", installation: false },
];
