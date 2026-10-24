# Code rewind

The existing return-here action offers conversation only, code only, or both. The selected user turn is inclusive: code restore returns files to the state before its first tracked edit and reverses later tracked edits in that session. Conversation restore removes the selected user message and everything after it, returning its input to the composer. Code-only restore preserves the transcript, composer and queued messages. Edit-and-resend and fork retain their existing filesystem behavior.

Checkpoints capture original bytes immediately before authorized local `write_file`, `edit_file`, `multi_edit`, `apply_patch`, `move_file`, and `delete_file` effects. They are grouped by the initiating user message and survive restart. Creation records prior absence, so restoring it deletes the new file. Deletion preserves bytes and mode. Moves track both source and destination, including an overwritten destination. Multi-file patches record each effect before that effect runs; a failed patch can retain earlier applied effects.

Shell commands, including bash side effects, are not checkpointed. File transfers, remote workload edits and subagent dispatch make code restore unavailable for any selected range crossing their turn. Children can outlive the initiating turn, so their turns do not create separate code checkpoints or consume the profile turn cap. Missing or pruned checkpoints refuse explicitly. Conversation-only restore remains available. Rewind does not replace version control.

Code restore retains hash guards for its restored baseline. Repeating that restore checks for external changes again. Later code checkpoints whose edits were undone become unavailable; they cannot silently succeed as forward restores. Earlier checkpoints and new turns can still rewind through the restored baseline.

Before restore, all affected files must pass the current write-directory and sensitive-path checks and match the last native edit's SHA-256 hash, or be absent after a deletion. Gaps between consecutive edits also refuse, protecting external changes made between agent edits. Refusals list conflicting paths and leave files and conversation untouched. An uncapturable original, including a symlink, hard link or oversized file, makes the turn unavailable without blocking an authorized edit. Restore refuses links, special files, changed ancestor resolution and oversized files. It stages replacement bytes and rechecks policy and hashes before applying changes.

Concurrent external writers cannot be locked by the host. An I/O failure during replacement can leave a partial restore and returns failure without truncating the conversation. The original checkpoint remains on failure, but already restored files can then conflict with its expected after-hashes. Inspect the affected files and recover using version control before retrying.

[CODE_CHECKPOINT_POLICY](../../src/shared/code-rewind.ts) owns the limits: 8 MiB for either image of a file, 100 turns per session, 500 turns and 64 MiB retained serialized storage across the profile. Oldest whole session prefixes are pruned on admission. In-flight restore ranges are pinned; if their originals cannot fit, the affected turn becomes unavailable and the authorized edit continues. Pinned metadata may temporarily exceed the turn caps until those turns settle.

The private `code-checkpoints` feature namespace stores a versioned `turns.json` metadata index and immutable `image-<uuid>.json` before-images. An edit writes only its new images and the small index, with atomic private-file writes and no-follow, identity, ownership and link-count checks on reads. Staging briefly needs space alongside retained files. Legacy inline ledgers migrate on first access. Invalid ledgers are moved to `turns.json.corrupt-<timestamp>-<uuid>.bak`; their old restore points become unavailable while new turns continue. Unreferenced images are removed after index commits. Session deletion removes its index entries and originals, including orphan images and all quarantined ledgers whose session ownership cannot be recovered. File tools retain their existing authorization, fresh-read checks and broker routing.

## Comparison with Claude Code

Source: [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing), accessed 2026-10-22. Claims not listed as matching are Ave's own design.

Matches Claude Code:

- Conversation-only, code-only and both restores at a prompt that starts a turn; conversation restore returns that prompt to the input.
- File-editing tool changes are tracked; Bash side effects and external edits are not. Checkpoints survive resuming a conversation.
- 100 checkpoints per conversation.
- Rewind does not replace version control.

Intended differences:

- Claude Code skips symlinked and hard-linked paths and restores the rest with a warning. Ave refuses the whole restore and lists conflicting paths, including externally changed files, rather than skipping part of the selected range.
- Claude Code removes snapshots in a retention sweep, by default about 30 days after the session last saved one, and keeps each file's first snapshot when discarding older checkpoints. Ave has no time-based sweep. It prunes oldest whole turns to the 100-turn, 500-turn and 64 MiB caps, so surviving restore ranges stay complete.

Additional behavior includes the 8 MiB per-image, 500-turn and 64 MiB profile limits; hash guards and consumed later checkpoints; unavailability across file transfers, remote edits and subagent dispatch; and partial-restore disclosure on I/O failure. Summarize actions and mid-turn queued messages are out of scope here.
