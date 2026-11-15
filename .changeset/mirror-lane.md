---
"@vivari/core": minor
---

Filesystem: opt-in `BootOptions.mirrorLane` persists VFS file bodies through an append-only journal in a dedicated worker instead of a per-file `createSyncAccessHandle → truncate → write → flush → close` on the FS worker's thread. The journal is flushed once per drain, then the per-path OPFS files are rebuilt off the caller's thread; a crashed journal is replayed before the VFS restore, and a lane that cannot start (a second tab owns the journal, private mode) falls back to the direct path. Measured in the downstream studio (Chrome 156): a 200 × 3 KiB project write drops from ~1.0 s to ~16 ms on the FS thread, and 1 000 edits from ~4.3 s to ~0.1 s.
