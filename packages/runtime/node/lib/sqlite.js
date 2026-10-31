// lib/sqlite.js — Node's node:sqlite module.
//
// Upstream (https://github.com/nodejs/node/blob/v24.18.0/lib/sqlite.js) is exactly this:
// the module IS the binding. Everything lives in internalBinding('sqlite'), which here is
// packages/runtime/node/bindings/sqlite.js over the same wasm SQLite as bun:sqlite.
//
// Reachable only as `node:sqlite`. Like `node:test` and `node:sea`, Node never resolves the
// bare `sqlite` to the builtin: that name belongs to the npm package of the same name, and
// the loader keeps it that way (PREFIX_ONLY in ../loader.js).

export default function (exports, require, module, process, internalBinding) {
  "use strict";
  module.exports = internalBinding("sqlite");
}
