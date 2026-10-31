---
"@vivari/core": minor
"@vivari/react": minor
---

`node:sqlite` is available in guest processes (`DatabaseSync`, `StatementSync`), on the same wasm SQLite as `bun:sqlite`, and matches real Node's behaviour case by case. SQLite file locks are now real across processes and threads, so several processes can write one database without losing rows; `bun:sqlite` gets this too. `crypto.getCurves()` exists and returns an empty list until ECDH is supported.
