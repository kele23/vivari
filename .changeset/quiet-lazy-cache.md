---
"@vivari/core": minor
---

Filesystem: `BootOptions.deferCacheFiles` leaves package-manager cache bodies in the OPFS mirror at boot and replays each one the first time a syscall reads it, so a tab carries only the cache entries its own installs use. Cache directories are still replayed, `READDIR` merges the deferred names, existence is answered from the index, a truncating write never replays old bytes, and deleting a deferred entry drops the OPFS copy instead of reading it.
