---
"@vivari/core": patch
---

Runtime: the ESM→CJS transpiler now skips comments between `export` and the declaration it
prefixes. zod v4's build emits `export /*@__NO_SIDE_EFFECTS__*/ function`, which the scanner
read as "not an export" and left in the CJS body — every server route importing zod failed
in-VM with `Unexpected token 'export'`.
