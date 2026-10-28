---
"@vivari/core": patch
---

Runtime: `import.meta.resolve()` now returns a URL string (`file://…` for modules, `node:…` for core builtins) like Node, instead of the bare filesystem path `require.resolve()` returns.
