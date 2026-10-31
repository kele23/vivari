---
"@vivari/core": patch
---

Runtime: a module whose id reaches the ESM loader as a relative path no longer gets
`import.meta.url` = `file://home/…` (the first segment parsed as the URL host). The URL is
built from a root-relative path, the same rule stack frames already follow, and
`fileURLToPath()` no longer converts a hostful file URL into a plausible wrong path
(`/user/…`); it rebuilds the path that was meant.
