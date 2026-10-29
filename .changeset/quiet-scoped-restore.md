---
"@vivari/core": minor
---

Filesystem: `BootOptions.deferRestoreRoots` names project roots whose persisted files stay in the OPFS mirror at boot; the new `vv-restore-roots` request replays one of them into the VFS when the project is actually opened. A tab with many saved projects now pays RAM and boot time only for the projects it opens, instead of for every project on the origin.
