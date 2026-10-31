---
"@vivari/core": patch
---

Runtime: a `file:` URL whose first path segment a browser promoted to the URL **host** is
converted back to the absolute path it meant instead of throwing
`ERR_INVALID_FILE_URL_HOST`. Chrome on Windows parses `"file:" + "/home/user/x"` as
`file://home/user/x` (its `file:` parser has a WIN32 UNC branch), which is how PGlite's CJS
build locates its wasm — and why a project database failed to boot there while Node and
Chrome/Linux stayed green. `Bun.fileURLToPath` and `Bun.file(URL)` follow the same rule; a
three-slash URL, `localhost` and the non-file-scheme error are unchanged.
