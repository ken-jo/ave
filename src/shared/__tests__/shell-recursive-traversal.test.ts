import { describe, expect, it } from "vitest";
import { mayTraverseRecursively, recursiveTraversalFlag, RECURSIVE_TRAVERSAL_COMMANDS } from "../shell-recursive-traversal.js";

const argv = (command: string) => command.split(" ").map(word => word === "$x" ? undefined : word);

describe("mayTraverseRecursively", () => {
  it.each([
    "find .", "grep -r term .", "ls -R", "cp -a src out", "du", "du -sh src", "rsync -a src/ out", "rsync -avz src/ out",
    "rsync --recursive src/ out", "rsync --archive src/ out", "rsync -r src/ out", "git grep term", "git -C repo grep term",
    "rm -rf build", "chmod -R 700 dir", "scp -r dir host:", "exec find .", "eval 'grep -r x .'", "bash -c 'ls'",
    "sh -c 'cat notes.txt'", "env grep -R term .", "env FOO=1 du", "timeout 5 find .", "nice -n 10 tree", "xargs grep -r x",
    "python walk.py", "./script.sh", "$x", "ls $x",
  ])("counts %s as walking", command => {
    expect(mayTraverseRecursively(argv(command))).toBe(true);
  });

  it.each(["printf ready", "grep term notes.txt", "ls -la", "cat notes.txt", "rsync src out", "git status", "cp a b", "rm notes.txt", "env ls -la", "timeout 5 cat notes.txt"])
  ("counts %s as flat", command => {
    expect(mayTraverseRecursively(argv(command))).toBe(false);
  });

  it("leaves the path-policy tables unchanged", () => {
    expect([...RECURSIVE_TRAVERSAL_COMMANDS].sort()).toEqual(["fd", "fdfind", "find", "rg", "tar", "tree", "unzip", "zip"]);
    expect(recursiveTraversalFlag("rsync", ["rsync", "-a", "src", "out"])).toBeUndefined();
    expect(recursiveTraversalFlag("du", ["du", "-sh", "src"])).toBeUndefined();
    expect(recursiveTraversalFlag("grep", ["grep", "-r", "x", "."])).toBe("-r");
  });
});
