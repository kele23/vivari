---
"@vivari/core": patch
---

Runtime: the OPFS mirror drains project paths ahead of package-manager cache paths and rewrites its manifest while the queue is busy, so an edit made during a cold install survives a reload instead of being lost behind the cache backlog.
