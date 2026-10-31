---
"@vivari/core": patch
---

OPFS: a second Studio tab on the same origin no longer drops the first tab's paths from
the VFS mirror's index — the write is a read-merge-write of this kernel's changed paths,
serialized with a 'vv-vfs-manifest' Web Lock — and the index is replaced through a staged
copy, so a tab that boots while another is writing restores the tree instead of an empty
workspace. Boot reads the index under the same lock, and a change recorded while an index
write is in flight is kept for the next write instead of being dropped from the index.
