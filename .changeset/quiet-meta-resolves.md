---
"@vivari/core": patch
---

Runtime: `import.meta.resolve()` now returns a URL string like Node, instead of the bare filesystem path `require.resolve()` returns: `file://…` for modules (escaped the way `pathToFileURL` does, so `@scope` stays literal) and `node:…` for Node core builtins. Other ids such as `bun:sqlite` and `bun` come back unchanged, as in Bun.
