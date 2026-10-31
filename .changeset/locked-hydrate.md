---
"@vivari/core": patch
---

Filesystem: hydrate() reads the shared OPFS index under the same `vv-vfs-manifest` Web Lock as restore() and writeManifest(), so opening a project in one tab cannot hold a sync access handle on the index while another tab replaces it.
