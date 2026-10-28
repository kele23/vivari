---
"@vivari/core": patch
---

Runtime: fall back to the next `exports` condition (and to `module`) when a package's declared `main`/`require` target is absent, so pruned ESM-only copies such as nitro's traced `dist/node_modules` load instead of throwing `MODULE_NOT_FOUND`.
