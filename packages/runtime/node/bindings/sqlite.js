// internalBinding('sqlite') — node:sqlite (DatabaseSync, StatementSync) on real SQLite.
//
// Upstream this is src/node_sqlite.cc over the SQLite that Node links in, and
// lib/sqlite.js is a one-line re-export of the binding. Here the engine is the same
// official sqlite.org wasm build bun:sqlite drives, over the same VFS onto Vivari's
// synchronous fs (builtins/bun-sqlite.js has the engine, the VFS and the locking), and
// this file is the node_sqlite.cc half: Node's API shape, Node's binding rules and
// Node's error codes. The two modules share one engine per process.
//
// The behaviour was not read off the docs. Each rule below was measured against a real
// node:sqlite (Node 24.21) and scripts/spike-node-sqlite.mjs replays the same script on
// both and compares the transcripts, so a rule that drifts is a red gate rather than a
// comment. The non-obvious ones, because each is the opposite of bun:sqlite's:
//
//   * A JS number ALWAYS binds as a double (`typeof(?)` is 'real' for 1), a boolean as
//     an integer, and an integer column wider than 2^53 THROWS ERR_OUT_OF_RANGE unless
//     readBigInts is on. Bun truncates instead.
//   * Rows are null-prototype objects, get() of nothing is `undefined` (Bun: null).
//   * A first argument that is a plain object is the NAMED parameters, and the rest
//     bind to the anonymous `?` slots, skipping named ones. A named key may omit its
//     sigil (allowBareNamedParameters), and an unknown key throws.
//   * An error thrown inside a user-defined function reaches the caller as THAT error,
//     not as a SQLite error carrying its message.
//
// WHY THE NEED WAS REAL. pnpm 11 keeps its store index in SQLite through node:sqlite,
// and before this the id was not registered at all, so `require("node:sqlite")` threw
// at module load and pnpm could not even print its version.
//
// WHAT IS NOT HERE, AND SAYS SO. Extensions (no dlopen in a tab, and the build omits
// the loader), sessions and changesets (the engine has them; this binding does not wire
// them yet), backup() and setAuthorizer(). Each throws naming the API and the reason.
// WAL is accepted and answered truthfully: SQLite reports the journal mode actually in
// effect, which is "delete", because the VFS has no shared memory. Unlike bun:sqlite
// this does not print a warning: the main caller here is pnpm, which asks for WAL on
// every connection of every install, and a warning per worker per install would be
// read once and then ignored for ever.

import {
  SQLITE_OK,
  SQLITE_ROW,
  SQLITE_DONE,
  SQLITE_ERROR,
} from "../../builtins/bun-sqlite.js";

const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;
const SQLITE_TRANSIENT = -1;

const OPEN_READONLY = 0x01;
const OPEN_READWRITE = 0x02;
const OPEN_CREATE = 0x04;
const OPEN_URI = 0x40;

const SQLITE_UTF8 = 1;
const SQLITE_DETERMINISTIC = 0x800;
const SQLITE_DIRECTONLY = 0x80000;

const DBCONFIG_ENABLE_FKEY = 1002;
const DBCONFIG_DEFENSIVE = 1010;
const DBCONFIG_DQS_DML = 1013;
const DBCONFIG_DQS_DDL = 1014;

const DESERIALIZE_FREEONCLOSE = 1;
const DESERIALIZE_RESIZEABLE = 2;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

// Node's public table, verbatim (sqlite.constants on Node 24.21).
export const SQLITE_CONSTANTS = Object.freeze({
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5,
  SQLITE_OK: 0,
  SQLITE_DENY: 1,
  SQLITE_IGNORE: 2,
  SQLITE_CREATE_INDEX: 1,
  SQLITE_CREATE_TABLE: 2,
  SQLITE_CREATE_TEMP_INDEX: 3,
  SQLITE_CREATE_TEMP_TABLE: 4,
  SQLITE_CREATE_TEMP_TRIGGER: 5,
  SQLITE_CREATE_TEMP_VIEW: 6,
  SQLITE_CREATE_TRIGGER: 7,
  SQLITE_CREATE_VIEW: 8,
  SQLITE_DELETE: 9,
  SQLITE_DROP_INDEX: 10,
  SQLITE_DROP_TABLE: 11,
  SQLITE_DROP_TEMP_INDEX: 12,
  SQLITE_DROP_TEMP_TABLE: 13,
  SQLITE_DROP_TEMP_TRIGGER: 14,
  SQLITE_DROP_TEMP_VIEW: 15,
  SQLITE_DROP_TRIGGER: 16,
  SQLITE_DROP_VIEW: 17,
  SQLITE_INSERT: 18,
  SQLITE_PRAGMA: 19,
  SQLITE_READ: 20,
  SQLITE_SELECT: 21,
  SQLITE_TRANSACTION: 22,
  SQLITE_UPDATE: 23,
  SQLITE_ATTACH: 24,
  SQLITE_DETACH: 25,
  SQLITE_ALTER_TABLE: 26,
  SQLITE_REINDEX: 27,
  SQLITE_ANALYZE: 28,
  SQLITE_CREATE_VTABLE: 29,
  SQLITE_DROP_VTABLE: 30,
  SQLITE_FUNCTION: 31,
  SQLITE_SAVEPOINT: 32,
  SQLITE_COPY: 0,
  SQLITE_RECURSIVE: 33,
});

// db.limits: Node's property name -> SQLITE_LIMIT_* id.
const LIMITS = [
  ["length", 0],
  ["sqlLength", 1],
  ["column", 2],
  ["exprDepth", 3],
  ["compoundSelect", 4],
  ["vdbeOp", 5],
  ["functionArg", 6],
  ["attach", 7],
  ["likePatternLength", 8],
  ["variableNumber", 9],
  ["triggerDepth", 10],
];

// ---- Node-shaped errors -----------------------------------------------------------------

function nodeError(Ctor, code, message) {
  const e = new Ctor(message);
  e.code = code;
  return e;
}
const argType = (message) => nodeError(TypeError, "ERR_INVALID_ARG_TYPE", message);
const invalidState = (message) => nodeError(Error, "ERR_INVALID_STATE", message);
const mustBeBoolean = (name) => argType(`The "${name}" argument must be a boolean.`);

function unsupported(api, why) {
  return nodeError(Error, "ERR_METHOD_NOT_IMPLEMENTED", `${api} is not supported in Vivari (browser sandbox): ${why}`);
}
function unimplemented(api, why) {
  return nodeError(Error, "ERR_METHOD_NOT_IMPLEMENTED", `${api} is not implemented in Vivari's node:sqlite: ${why}`);
}

// Internal state is non-enumerable, as a C++ object's is: Object.keys(db) on Node is
// exactly its public accessors, and code that spreads or serialises one sees no more.
function hidden(target, fields) {
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
  }
}

function checkBool(value, name) {
  if (typeof value !== "boolean") throw mustBeBoolean(name);
  return value;
}

// ---- value mapping (pure, exported for the offline spike) ---------------------------------

/**
 * How Node binds one JS value (node_sqlite.cc BindValue). Returns { kind, value } or
 * throws Node's error for that value.
 */
export function classifyBind(value, index) {
  if (value === null) return { kind: "null" };
  const t = typeof value;
  if (t === "number") return { kind: "double", value };
  if (t === "string") return { kind: "text", value };
  if (t === "boolean") return { kind: "int", value: value ? 1n : 0n };
  if (t === "bigint") {
    if (value < INT64_MIN || value > INT64_MAX) {
      throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "BigInt value is too large to bind.");
    }
    return { kind: "int", value };
  }
  if (ArrayBuffer.isView(value)) {
    return { kind: "blob", value: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
  }
  if (value instanceof ArrayBuffer) return { kind: "blob", value: new Uint8Array(value) };
  throw argType(`Provided value cannot be bound to SQLite parameter ${index}.`);
}

/** Node's rule for "the first argument is the named parameters". */
export function isNamedParams(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer)
  );
}

/** An INTEGER read out of SQLite, as Node returns it. */
export function readInt64(value, readBigInts) {
  if (readBigInts) return value;
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw nodeError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `Value is too large to be represented as a JavaScript number: ${value}`,
    );
  }
  return Number(value);
}

// ---- the binding --------------------------------------------------------------------------

/**
 * Build the binding. `getHost()` returns the SQLite host (createVivariSqliteHost) and is
 * only called when a database is first opened, so requiring node:sqlite costs nothing.
 */
export function createSqliteBinding(getHost) {
  let engine = null;
  let dispatch = null;
  function getEngine() {
    if (engine) return engine;
    const host = getHost();
    engine = host.getEngine();
    return engine;
  }

  // ---- heap helpers ----
  function withCString(str, fn) {
    const ptr = engine.allocCString(str);
    try {
      return fn(ptr);
    } finally {
      engine.exports.free(ptr);
    }
  }
  function readText(ptr, len) {
    return new TextDecoder().decode(engine.u8().subarray(ptr, ptr + len));
  }

  function sqliteError(pDb, fallback) {
    const E = engine.exports;
    const errcode = pDb ? E.sqlite3_extended_errcode(pDb) : SQLITE_ERROR;
    const message = (pDb && engine.readCString(E.sqlite3_errmsg(pDb))) || fallback || "SQLite error";
    const e = nodeError(Error, "ERR_SQLITE_ERROR", message);
    e.errcode = errcode;
    e.errstr = engine.readCString(E.sqlite3_errstr(errcode));
    return e;
  }

  // ---- user-defined functions: one set of dispatchers per engine, keyed by user data ----
  //
  // SQLite calls a function through a pointer, and a JS function only gets a pointer by
  // growing the wasm table. So every registered function shares six trampolines
  // installed once, and finds its JS side through sqlite3_user_data(ctx), which is
  // just an id into `fns`. xDestroy removes the entry when SQLite drops the function
  // (a redefinition, or the database closing).
  const fns = new Map();
  let nextFnId = 1;
  const aggState = new Map(); // aggregate-context pointer -> { value }

  function valueToJs(pVal, useBigInt) {
    const E = engine.exports;
    switch (E.sqlite3_value_type(pVal)) {
      case SQLITE_INTEGER: {
        const v = E.sqlite3_value_int64(pVal);
        return useBigInt ? v : readInt64(v, false);
      }
      case SQLITE_FLOAT:
        return E.sqlite3_value_double(pVal);
      case SQLITE_TEXT: {
        const ptr = E.sqlite3_value_text(pVal);
        return readText(ptr, E.sqlite3_value_bytes(pVal));
      }
      case SQLITE_BLOB: {
        const ptr = E.sqlite3_value_blob(pVal);
        return engine.u8().slice(ptr, ptr + E.sqlite3_value_bytes(pVal));
      }
      default:
        return null;
    }
  }
  function readArgs(argc, argv, useBigInt) {
    const args = new Array(argc);
    for (let i = 0; i < argc; i++) {
      args[i] = valueToJs(engine.dv().getUint32(argv + i * 4, true), useBigInt);
    }
    return args;
  }
  function resultError(ctx, message) {
    withCString(message, (z) => engine.exports.sqlite3_result_error(ctx, z, -1));
  }
  function setResult(ctx, value) {
    const E = engine.exports;
    if (value === undefined || value === null) return E.sqlite3_result_null(ctx);
    if (typeof value === "number") return E.sqlite3_result_double(ctx, value);
    if (typeof value === "bigint") {
      if (value < INT64_MIN || value > INT64_MAX) return resultError(ctx, "BigInt value is too large for SQLite");
      return E.sqlite3_result_int64(ctx, value);
    }
    if (typeof value === "string") {
      const b = new TextEncoder().encode(value);
      const ptr = engine.allocBytes(b);
      try {
        return E.sqlite3_result_text(ctx, ptr, b.length, SQLITE_TRANSIENT);
      } finally {
        E.free(ptr);
      }
    }
    if (ArrayBuffer.isView(value)) {
      const b = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const ptr = engine.allocBytes(b);
      try {
        return E.sqlite3_result_blob(ctx, ptr, b.length, SQLITE_TRANSIENT);
      } finally {
        E.free(ptr);
      }
    }
    if (value && typeof value.then === "function") {
      return resultError(ctx, "Asynchronous user-defined functions are not supported");
    }
    return resultError(ctx, "Returned JavaScript value cannot be converted to a SQLite value");
  }
  // A throw inside a callback cannot cross the wasm frame it was called from, so it is
  // parked on the database and re-thrown by whoever stepped the statement. SQLite is
  // told with a result error so it unwinds the statement cleanly.
  function guard(ctx, entry, fn) {
    try {
      fn();
    } catch (e) {
      entry.db._pendingError = e;
      resultError(ctx, (e && e.message) || String(e));
    }
  }
  function aggregateFor(ctx, entry, create) {
    const E = engine.exports;
    const key = E.sqlite3_aggregate_context(ctx, create ? 8 : 0);
    if (!key) return null;
    let state = aggState.get(key);
    if (!state) {
      const start = entry.start;
      state = { value: typeof start === "function" ? start() : start };
      aggState.set(key, state);
    }
    return { key, state };
  }

  function getDispatch() {
    if (dispatch) return dispatch;
    const E = engine.exports;
    const entryFor = (ctx) => fns.get(E.sqlite3_user_data(ctx));
    dispatch = {
      xFunc: engine.installFunction((ctx, argc, argv) => {
        const entry = entryFor(ctx);
        guard(ctx, entry, () => setResult(ctx, entry.fn(...readArgs(argc, argv, entry.useBigInt))));
      }, "viii"),
      xStep: engine.installFunction((ctx, argc, argv) => {
        const entry = entryFor(ctx);
        guard(ctx, entry, () => {
          const { state } = aggregateFor(ctx, entry, true);
          state.value = entry.step(state.value, ...readArgs(argc, argv, entry.useBigInt));
        });
      }, "viii"),
      xInverse: engine.installFunction((ctx, argc, argv) => {
        const entry = entryFor(ctx);
        guard(ctx, entry, () => {
          const { state } = aggregateFor(ctx, entry, true);
          state.value = entry.inverse(state.value, ...readArgs(argc, argv, entry.useBigInt));
        });
      }, "viii"),
      xValue: engine.installFunction((ctx) => {
        const entry = entryFor(ctx);
        guard(ctx, entry, () => {
          const { state } = aggregateFor(ctx, entry, true);
          setResult(ctx, entry.result ? entry.result(state.value) : state.value);
        });
      }, "vi"),
      xFinal: engine.installFunction((ctx) => {
        const entry = entryFor(ctx);
        guard(ctx, entry, () => {
          // No context means no rows reached step(): the result is that of the start
          // value alone, which is how Node answers an aggregate over an empty set.
          const found = aggregateFor(ctx, entry, false);
          let value;
          if (found) {
            value = found.state.value;
            aggState.delete(found.key);
          } else {
            value = typeof entry.start === "function" ? entry.start() : entry.start;
          }
          setResult(ctx, entry.result ? entry.result(value) : value);
        });
      }, "vi"),
      xDestroy: engine.installFunction((id) => {
        fns.delete(id);
      }, "vi"),
    };
    return dispatch;
  }

  // ---- StatementSync -------------------------------------------------------------------

  let constructing = false;

  class StatementSync {
    constructor() {
      if (!constructing) throw nodeError(Error, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
      constructing = false;
    }

    _check() {
      if (!this._pStmt || !this._db._pDb) throw invalidState("statement has been finalized");
    }

    _finalize() {
      if (!this._pStmt) return;
      if (this._db._pDb) engine.exports.sqlite3_finalize(this._pStmt);
      this._db._statements.delete(this._pStmt);
      this._pStmt = 0;
    }

    _bindDirect(index, value) {
      const E = engine.exports;
      const p = this._pStmt;
      const c = classifyBind(value, index);
      let rc;
      if (c.kind === "null") rc = E.sqlite3_bind_null(p, index);
      else if (c.kind === "double") rc = E.sqlite3_bind_double(p, index, c.value);
      else if (c.kind === "int") rc = E.sqlite3_bind_int64(p, index, c.value);
      else {
        const bytes = c.kind === "text" ? new TextEncoder().encode(c.value) : c.value;
        const ptr = engine.allocBytes(bytes);
        try {
          rc = c.kind === "text"
            ? E.sqlite3_bind_text(p, index, ptr, bytes.length, SQLITE_TRANSIENT)
            : E.sqlite3_bind_blob(p, index, ptr, bytes.length, SQLITE_TRANSIENT);
        } finally {
          E.free(ptr);
        }
      }
      if (rc !== SQLITE_OK) throw sqliteError(this._db._pDb);
    }

    _bareNames() {
      if (this._bare) return this._bare;
      const E = engine.exports;
      const map = new Map();
      const n = E.sqlite3_bind_parameter_count(this._pStmt);
      for (let i = 1; i <= n; i++) {
        const full = engine.readCString(E.sqlite3_bind_parameter_name(this._pStmt, i));
        if (!full) continue;
        const bare = full.slice(1);
        const seen = map.get(bare);
        if (seen && seen !== full) {
          throw invalidState(
            `Cannot create bare named parameter '${bare}' because of conflicting names '${seen}' and '${full}'.`,
          );
        }
        map.set(bare, full);
      }
      return (this._bare = map);
    }

    // node_sqlite.cc BindParams: clear, then named from a leading object, then the rest
    // into the anonymous slots in order, stepping over any slot that has a name.
    _bind(args) {
      const E = engine.exports;
      const p = this._pStmt;
      E.sqlite3_reset(p);
      E.sqlite3_clear_bindings(p);
      let start = 0;
      if (args.length > 0 && isNamedParams(args[0])) {
        const named = args[0];
        start = 1;
        for (const key of Object.getOwnPropertyNames(named)) {
          let index = withCString(key, (z) => E.sqlite3_bind_parameter_index(p, z));
          if (index === 0 && this._allowBare) {
            const full = this._bareNames().get(key);
            if (full) index = withCString(full, (z) => E.sqlite3_bind_parameter_index(p, z));
          }
          if (index === 0) {
            if (this._allowUnknown) continue;
            throw invalidState(`Unknown named parameter '${key}'`);
          }
          this._bindDirect(index, named[key]);
        }
      }
      let slot = 1;
      for (let i = start; i < args.length; i++) {
        while (E.sqlite3_bind_parameter_name(p, slot)) slot++;
        this._bindDirect(slot, args[i]);
        slot++;
      }
    }

    _step() {
      const rc = engine.exports.sqlite3_step(this._pStmt);
      if (rc === SQLITE_ROW || rc === SQLITE_DONE) return rc;
      const db = this._db;
      const pending = db._pendingError;
      db._pendingError = null;
      const err = pending || sqliteError(db._pDb);
      engine.exports.sqlite3_reset(this._pStmt);
      throw err;
    }

    _row() {
      const E = engine.exports;
      const p = this._pStmt;
      const n = E.sqlite3_column_count(p);
      const read = (i) => {
        switch (E.sqlite3_column_type(p, i)) {
          case SQLITE_INTEGER:
            return readInt64(E.sqlite3_column_int64(p, i), this._readBigInts);
          case SQLITE_FLOAT:
            return E.sqlite3_column_double(p, i);
          case SQLITE_TEXT: {
            const ptr = E.sqlite3_column_text(p, i);
            return readText(ptr, E.sqlite3_column_bytes(p, i));
          }
          case SQLITE_BLOB: {
            const ptr = E.sqlite3_column_blob(p, i);
            return engine.u8().slice(ptr, ptr + E.sqlite3_column_bytes(p, i));
          }
          default:
            return null;
        }
      };
      if (this._returnArrays) {
        const row = new Array(n);
        for (let i = 0; i < n; i++) row[i] = read(i);
        return row;
      }
      const row = Object.create(null);
      for (let i = 0; i < n; i++) row[engine.readCString(E.sqlite3_column_name(p, i))] = read(i);
      return row;
    }

    _changes() {
      const E = engine.exports;
      const pDb = this._db._pDb;
      const changes = BigInt(E.sqlite3_changes(pDb));
      const rowid = E.sqlite3_last_insert_rowid(pDb);
      return this._readBigInts
        ? { changes, lastInsertRowid: rowid }
        : { changes: Number(changes), lastInsertRowid: readInt64(rowid, false) };
    }

    all(...args) {
      this._check();
      this._bind(args);
      const rows = [];
      try {
        while (this._step() === SQLITE_ROW) rows.push(this._row());
      } finally {
        engine.exports.sqlite3_reset(this._pStmt);
      }
      return rows;
    }

    get(...args) {
      this._check();
      this._bind(args);
      try {
        return this._step() === SQLITE_ROW ? this._row() : undefined;
      } finally {
        engine.exports.sqlite3_reset(this._pStmt);
      }
    }

    run(...args) {
      this._check();
      this._bind(args);
      try {
        while (this._step() === SQLITE_ROW) {
          /* drain: run() reports the effect, not the rows */
        }
        return this._changes();
      } finally {
        engine.exports.sqlite3_reset(this._pStmt);
      }
    }

    iterate(...args) {
      this._check();
      this._bind(args);
      const stmt = this;
      let done = false;
      const finish = () => {
        done = true;
        if (stmt._pStmt && stmt._db._pDb) engine.exports.sqlite3_reset(stmt._pStmt);
        return result(true, null);
      };
      const result = (isDone, value) => {
        const r = Object.create(null);
        r.done = isDone;
        r.value = value;
        return r;
      };
      const Base = globalThis.Iterator && globalThis.Iterator.prototype;
      const it = Object.create(Base || Object.prototype);
      it.next = () => {
        stmt._check();
        if (done) return result(true, null);
        if (stmt._step() !== SQLITE_ROW) return finish();
        return result(false, stmt._row());
      };
      it.return = () => {
        stmt._check();
        return finish();
      };
      if (!Base) it[Symbol.iterator] = function () { return this; };
      return it;
    }

    columns() {
      this._check();
      const E = engine.exports;
      const p = this._pStmt;
      const n = E.sqlite3_column_count(p);
      const out = [];
      for (let i = 0; i < n; i++) {
        const c = Object.create(null);
        c.column = engine.readCString(E.sqlite3_column_origin_name(p, i));
        c.database = engine.readCString(E.sqlite3_column_database_name(p, i));
        c.name = engine.readCString(E.sqlite3_column_name(p, i));
        c.table = engine.readCString(E.sqlite3_column_table_name(p, i));
        c.type = engine.readCString(E.sqlite3_column_decltype(p, i));
        out.push(c);
      }
      return out;
    }

    setReadBigInts(enabled) {
      this._check();
      this._readBigInts = checkBool(enabled, "readBigInts");
    }

    setReturnArrays(enabled) {
      this._check();
      this._returnArrays = checkBool(enabled, "returnArrays");
    }

    setAllowBareNamedParameters(enabled) {
      this._check();
      this._allowBare = checkBool(enabled, "allowBareNamedParameters");
    }

    setAllowUnknownNamedParameters(enabled) {
      this._check();
      this._allowUnknown = checkBool(enabled, "enabled");
    }
  }

  function makeStatement(db, pStmt) {
    constructing = true;
    const stmt = new StatementSync();
    hidden(stmt, {
      _db: db,
      _pStmt: pStmt,
      _bare: null,
      _readBigInts: db._options.readBigInts,
      _returnArrays: db._options.returnArrays,
      _allowBare: db._options.allowBareNamedParameters,
      _allowUnknown: db._options.allowUnknownNamedParameters,
    });
    // Own accessors, as on Node (Object.keys(stmt) is ['sourceSQL', 'expandedSQL']).
    Object.defineProperty(stmt, "sourceSQL", {
      enumerable: true,
      get() {
        stmt._check();
        return engine.readCString(engine.exports.sqlite3_sql(stmt._pStmt));
      },
    });
    Object.defineProperty(stmt, "expandedSQL", {
      enumerable: true,
      get() {
        stmt._check();
        const ptr = engine.exports.sqlite3_expanded_sql(stmt._pStmt);
        if (!ptr) throw sqliteError(db._pDb, "Expanded SQL text would exceed configured limits");
        const text = engine.readCString(ptr);
        engine.exports.sqlite3_free(ptr);
        return text;
      },
    });
    db._statements.set(pStmt, new WeakRef(stmt));
    if (statementRegistry) statementRegistry.register(stmt, { db, pStmt }, stmt);
    return stmt;
  }

  // A statement nobody holds any more is finalized when it is collected, as Node's
  // are, so a long-lived database does not accumulate prepared statements.
  const statementRegistry =
    typeof FinalizationRegistry === "function"
      ? new FinalizationRegistry(({ db, pStmt }) => {
        if (db._pDb && db._statements.has(pStmt)) {
          engine.exports.sqlite3_finalize(pStmt);
          db._statements.delete(pStmt);
        }
      })
      : null;

  // ---- DatabaseSync -------------------------------------------------------------------

  const OPTION_BOOLEANS = [
    ["open", true],
    ["readOnly", false],
    ["enableForeignKeyConstraints", true],
    ["enableDoubleQuotedStringLiterals", false],
    ["allowExtension", false],
    ["readBigInts", false],
    ["returnArrays", false],
    ["allowBareNamedParameters", true],
    ["allowUnknownNamedParameters", false],
    ["defensive", true],
  ];

  function databasePath(path) {
    const bad = () => argType('The "path" argument must be a string, Uint8Array, or URL without null bytes.');
    if (typeof path === "string") {
      if (path.includes("\0")) throw bad();
      return { name: path, uri: false };
    }
    if (path instanceof Uint8Array) {
      const name = new TextDecoder().decode(path);
      if (name.includes("\0")) throw bad();
      return { name, uri: false };
    }
    if (path && typeof path === "object" && typeof path.href === "string" && typeof path.protocol === "string") {
      if (path.protocol !== "file:" || path.href.includes("\0")) throw bad();
      return { name: path.href, uri: true };
    }
    throw bad();
  }

  function dbConfig(pDb, op, on) {
    const E = engine.exports;
    if (typeof E.sqlite3__wasm_db_config_ip !== "function") return false;
    return E.sqlite3__wasm_db_config_ip(pDb, op, on ? 1 : 0, 0) === SQLITE_OK;
  }

  class DatabaseSyncImpl {
    constructor(path, options) {
      const target = databasePath(path);
      if (options !== undefined && (options === null || typeof options !== "object")) {
        throw argType('The "options" argument must be an object.');
      }
      const opts = options || {};
      const resolved = {};
      for (const [name, fallback] of OPTION_BOOLEANS) {
        const v = opts[name];
        resolved[name] = v === undefined ? fallback : checkBool(v, "options." + name);
      }
      if (opts.timeout !== undefined && !Number.isInteger(opts.timeout)) {
        throw argType('The "options.timeout" argument must be an integer.');
      }
      resolved.timeout = opts.timeout === undefined ? 0 : opts.timeout;
      hidden(this, {
        _target: target,
        _options: resolved,
        _pDb: 0,
        _statements: new Map(),
        _pendingError: null,
        _loadExtensionEnabled: false,
      });
      const db = this;
      Object.defineProperty(this, "isOpen", { enumerable: true, get: () => db._pDb !== 0 });
      Object.defineProperty(this, "isTransaction", {
        enumerable: true,
        get() {
          db._checkOpen();
          return engine.exports.sqlite3_get_autocommit(db._pDb) === 0;
        },
      });
      const limits = {};
      for (const [name, id] of LIMITS) {
        Object.defineProperty(limits, name, {
          enumerable: true,
          get() {
            db._checkOpen();
            return engine.exports.sqlite3_limit(db._pDb, id, -1);
          },
          set(value) {
            db._checkOpen();
            if (!Number.isInteger(value) || value < 0) {
              throw nodeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "limits.${name}" is out of range. It must be a non-negative integer.`);
            }
            engine.exports.sqlite3_limit(db._pDb, id, value);
          },
        });
      }
      Object.defineProperty(this, "limits", { enumerable: true, value: limits });
      if (resolved.open) this.open();
    }

    _checkOpen() {
      if (!this._pDb) throw invalidState("database is not open");
    }

    open() {
      if (this._pDb) throw invalidState("database is already open");
      getEngine();
      const E = engine.exports;
      const o = this._options;
      const flags = (o.readOnly ? OPEN_READONLY : OPEN_READWRITE | OPEN_CREATE) | (this._target.uri ? OPEN_URI : 0);
      const ppDb = E.malloc(4);
      let rc;
      let pDb = 0;
      try {
        rc = withCString(this._target.name, (z) => E.sqlite3_open_v2(z, ppDb, flags, 0));
        pDb = engine.dv().getUint32(ppDb, true);
      } finally {
        E.free(ppDb);
      }
      if (rc !== SQLITE_OK) {
        const err = sqliteError(pDb, "unable to open database file");
        if (pDb) E.sqlite3_close_v2(pDb);
        throw err;
      }
      E.sqlite3_extended_result_codes(pDb, 1);
      // Node's open-time configuration (DatabaseSync::Open): double-quoted string
      // literals, foreign keys and defensive mode through sqlite3_db_config. The build
      // compiles DQS off and foreign keys off, so every one has to be set explicitly.
      const ok =
        dbConfig(pDb, DBCONFIG_DQS_DML, o.enableDoubleQuotedStringLiterals) &&
        dbConfig(pDb, DBCONFIG_DQS_DDL, o.enableDoubleQuotedStringLiterals) &&
        dbConfig(pDb, DBCONFIG_ENABLE_FKEY, o.enableForeignKeyConstraints) &&
        dbConfig(pDb, DBCONFIG_DEFENSIVE, o.defensive);
      if (!ok) {
        E.sqlite3_close_v2(pDb);
        throw unsupported("DatabaseSync", "this SQLite build cannot set its connection options (sqlite3_db_config)");
      }
      if (o.timeout > 0) E.sqlite3_busy_timeout(pDb, o.timeout);
      this._pDb = pDb;
      // The build's default page is 8 KiB and Node's SQLite uses 4 KiB. It only applies
      // to a database that is still empty, which is exactly when it decides the layout
      // a file is created with, and so what serialize() hands back.
      this._pragma("PRAGMA page_size = 4096");
    }

    _pragma(sql) {
      const E = engine.exports;
      const ppStmt = E.malloc(4);
      try {
        if (withCString(sql, (z) => E.sqlite3_prepare_v2(this._pDb, z, -1, ppStmt, 0)) !== SQLITE_OK) return;
        const pStmt = engine.dv().getUint32(ppStmt, true);
        if (!pStmt) return;
        while (E.sqlite3_step(pStmt) === SQLITE_ROW) {
          /* drain */
        }
        E.sqlite3_finalize(pStmt);
      } finally {
        E.free(ppStmt);
      }
    }

    close() {
      this._checkOpen();
      const E = engine.exports;
      for (const [pStmt, ref] of this._statements) {
        E.sqlite3_finalize(pStmt);
        const stmt = ref.deref();
        if (stmt) {
          stmt._pStmt = 0;
          if (statementRegistry) statementRegistry.unregister(stmt);
        }
      }
      this._statements.clear();
      E.sqlite3_close_v2(this._pDb);
      this._pDb = 0;
    }

    [Symbol.dispose]() {
      if (this._pDb) this.close();
    }

    location(dbName = "main") {
      if (typeof dbName !== "string") throw argType('The "dbName" argument must be a string.');
      this._checkOpen();
      const ptr = withCString(dbName, (z) => engine.exports.sqlite3_db_filename(this._pDb, z));
      const name = engine.readCString(ptr);
      return name ? name : null;
    }

    exec(sql) {
      if (typeof sql !== "string") throw argType('The "sql" argument must be a string.');
      this._checkOpen();
      const E = engine.exports;
      const zSql = engine.allocCString(sql);
      const ppStmt = E.malloc(4);
      const ppTail = E.malloc(4);
      try {
        let cursor = zSql;
        for (;;) {
          const rc = E.sqlite3_prepare_v2(this._pDb, cursor, -1, ppStmt, ppTail);
          if (rc !== SQLITE_OK) throw sqliteError(this._pDb);
          const pStmt = engine.dv().getUint32(ppStmt, true);
          const tail = engine.dv().getUint32(ppTail, true);
          if (pStmt) {
            let stepRc;
            try {
              do stepRc = E.sqlite3_step(pStmt);
              while (stepRc === SQLITE_ROW);
              if (stepRc !== SQLITE_DONE) {
                const pending = this._pendingError;
                this._pendingError = null;
                throw pending || sqliteError(this._pDb);
              }
            } finally {
              E.sqlite3_finalize(pStmt);
            }
          }
          if (!tail || tail === cursor || engine.u8()[tail] === 0) break;
          cursor = tail;
        }
      } finally {
        E.free(zSql);
        E.free(ppStmt);
        E.free(ppTail);
      }
    }

    prepare(sql) {
      if (typeof sql !== "string") throw argType('The "sql" argument must be a string.');
      this._checkOpen();
      const E = engine.exports;
      const ppStmt = E.malloc(4);
      let rc;
      let pStmt = 0;
      try {
        rc = withCString(sql, (z) => E.sqlite3_prepare_v2(this._pDb, z, -1, ppStmt, 0));
        pStmt = engine.dv().getUint32(ppStmt, true);
      } finally {
        E.free(ppStmt);
      }
      if (rc !== SQLITE_OK) throw sqliteError(this._pDb);
      if (!pStmt) throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "The SQL query contains no statements.");
      return makeStatement(this, pStmt);
    }

    function(name, options, fn) {
      if (typeof name !== "string") throw argType('The "name" argument must be a string.');
      if (typeof options === "function") {
        fn = options;
        options = undefined;
      }
      if (options !== undefined && (options === null || typeof options !== "object")) {
        throw argType('The "options" argument must be an object.');
      }
      if (typeof fn !== "function") throw argType('The "function" argument must be a function.');
      const o = readFunctionOptions(options || {});
      this._checkOpen();
      this._register(name, o, fn.length, { fn }, false);
    }

    aggregate(name, options) {
      if (typeof name !== "string") throw argType('The "name" argument must be a string.');
      if (options === null || typeof options !== "object") throw argType('The "options" argument must be an object.');
      const start = options.start;
      if (start === undefined || (typeof start === "object" && start !== null) || typeof start === "symbol") {
        throw argType('The "options.start" argument must be a function or a primitive value.');
      }
      if (typeof options.step !== "function") throw argType('The "options.step" argument must be a function.');
      for (const k of ["result", "inverse"]) {
        if (options[k] !== undefined && typeof options[k] !== "function") {
          throw argType(`The "options.${k}" argument must be a function.`);
        }
      }
      const o = readFunctionOptions(options);
      this._checkOpen();
      this._register(name, o, Math.max(0, options.step.length - 1), {
        start,
        step: options.step,
        result: options.result,
        inverse: options.inverse,
      }, true);
    }

    _register(name, o, length, entry, aggregate) {
      const E = engine.exports;
      const d = getDispatch();
      const id = nextFnId++;
      fns.set(id, { ...entry, db: this, useBigInt: o.useBigIntArguments });
      const nArg = o.varargs ? -1 : length;
      const flags = SQLITE_UTF8 | (o.deterministic ? SQLITE_DETERMINISTIC : 0) | (o.directOnly ? SQLITE_DIRECTONLY : 0);
      const rc = withCString(name, (z) => {
        if (!aggregate) {
          return E.sqlite3_create_function_v2(this._pDb, z, nArg, flags, id, d.xFunc, 0, 0, d.xDestroy);
        }
        if (entry.inverse) {
          return E.sqlite3_create_window_function(this._pDb, z, nArg, flags, id, d.xStep, d.xFinal, d.xValue, d.xInverse, d.xDestroy);
        }
        return E.sqlite3_create_function_v2(this._pDb, z, nArg, flags, id, 0, d.xStep, d.xFinal, d.xDestroy);
      });
      if (rc !== SQLITE_OK) throw sqliteError(this._pDb);
    }

    serialize(dbName = "main") {
      if (typeof dbName !== "string") throw argType('The "dbName" argument must be a string.');
      this._checkOpen();
      const E = engine.exports;
      const pSize = E.malloc(8);
      try {
        const ptr = withCString(dbName, (z) => E.sqlite3_serialize(this._pDb, z, pSize, 0));
        if (!ptr) throw sqliteError(this._pDb, "sqlite3_serialize() returned NULL");
        const size = Number(engine.dv().getBigInt64(pSize, true));
        const copy = engine.u8().slice(ptr, ptr + size);
        E.sqlite3_free(ptr);
        return copy;
      } finally {
        E.free(pSize);
      }
    }

    deserialize(buffer, options) {
      if (!ArrayBuffer.isView(buffer)) throw argType('The "buffer" argument must be a TypedArray or DataView.');
      const dbName = options && options.dbName !== undefined ? options.dbName : "main";
      if (typeof dbName !== "string") throw argType('The "options.dbName" argument must be a string.');
      this._checkOpen();
      const E = engine.exports;
      const src = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      // FREEONCLOSE hands the buffer to SQLite, so it must come from SQLite's allocator.
      const ptr = E.sqlite3_malloc(Math.max(1, src.length));
      if (!ptr) throw sqliteError(this._pDb, "out of memory");
      engine.u8().set(src, ptr);
      const rc = withCString(dbName, (z) =>
        E.sqlite3_deserialize(this._pDb, z, ptr, BigInt(src.length), BigInt(src.length),
          DESERIALIZE_FREEONCLOSE | DESERIALIZE_RESIZEABLE));
      if (rc !== SQLITE_OK) throw sqliteError(this._pDb);
    }

    createTagStore(capacity = 1000) {
      if (!Number.isInteger(capacity)) throw argType('The "capacity" argument must be an integer.');
      this._checkOpen();
      return new SQLTagStore(this, capacity);
    }

    enableLoadExtension(allow) {
      checkBool(allow, "allow");
      this._checkOpen();
      if (allow && !this._options.allowExtension) {
        throw invalidState("Cannot enable extension loading because it was disabled at database creation.");
      }
      this._loadExtensionEnabled = allow;
    }

    loadExtension(path) {
      if (typeof path !== "string") throw argType('The "path" argument must be a string.');
      this._checkOpen();
      if (!this._loadExtensionEnabled) throw invalidState("extension loading is not allowed");
      throw unsupported("DatabaseSync.prototype.loadExtension",
        "a SQLite extension is a native shared library, a browser tab has no dlopen(3), and this " +
          "SQLite build is compiled without the extension loader.");
    }

    enableDefensive(active) {
      checkBool(active, "active");
      this._checkOpen();
      if (!dbConfig(this._pDb, DBCONFIG_DEFENSIVE, active)) throw sqliteError(this._pDb);
    }

    createSession() {
      this._checkOpen();
      throw unimplemented("DatabaseSync.prototype.createSession",
        "the engine has the session extension, but this binding does not expose it yet.");
    }

    applyChangeset() {
      this._checkOpen();
      throw unimplemented("DatabaseSync.prototype.applyChangeset",
        "the engine has the session extension, but this binding does not expose it yet.");
    }

    setAuthorizer() {
      this._checkOpen();
      throw unimplemented("DatabaseSync.prototype.setAuthorizer", "authorizer callbacks are not wired up yet.");
    }
  }

  // A class constructor called without `new` throws V8's own TypeError before any of
  // its code runs, and Node's is ERR_CONSTRUCT_CALL_REQUIRED, so the public constructor
  // is a function that checks and then builds the class.
  function DatabaseSync(path, options) {
    if (!new.target) throw nodeError(TypeError, "ERR_CONSTRUCT_CALL_REQUIRED", "Cannot call constructor without `new`");
    return Reflect.construct(DatabaseSyncImpl, [path, options], new.target);
  }
  DatabaseSync.prototype = DatabaseSyncImpl.prototype;
  Object.defineProperty(DatabaseSync.prototype, "constructor", { value: DatabaseSync, writable: true, configurable: true });

  function readFunctionOptions(options) {
    const o = {};
    for (const name of ["useBigIntArguments", "varargs", "deterministic", "directOnly"]) {
      const v = options[name];
      o[name] = v === undefined ? false : checkBool(v, "options." + name);
    }
    return o;
  }

  // db.createTagStore(): a bounded LRU of prepared statements keyed by the template's
  // literal parts, with each interpolation bound as a parameter.
  class SQLTagStore {
    constructor(db, capacity) {
      hidden(this, { _db: db, _capacity: capacity, _cache: new Map() });
    }

    _statement(strings) {
      const sql = strings.join("?");
      let stmt = this._cache.get(sql);
      if (stmt && stmt._pStmt) {
        this._cache.delete(sql);
      } else {
        stmt = this._db.prepare(sql);
      }
      this._cache.set(sql, stmt);
      while (this._cache.size > this._capacity) this._cache.delete(this._cache.keys().next().value);
      return stmt;
    }

    get(strings, ...values) {
      return this._statement(strings).get(...values);
    }

    all(strings, ...values) {
      return this._statement(strings).all(...values);
    }

    iterate(strings, ...values) {
      return this._statement(strings).iterate(...values);
    }

    run(strings, ...values) {
      return this._statement(strings).run(...values);
    }

    clear() {
      this._cache.clear();
    }

    get size() {
      return this._cache.size;
    }

    get capacity() {
      return this._capacity;
    }

    get db() {
      return this._db;
    }
  }

  class Session {
    constructor() {
      throw nodeError(Error, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
    }
  }

  // Async on Node (it copies page batches between steps). Not wired: the engine's
  // backup API is not in this build's exports.
  function backup(sourceDb, path) {
    if (!(sourceDb instanceof DatabaseSyncImpl)) throw argType('The "sourceDb" argument must be an object.');
    databasePath(path);
    return Promise.reject(unimplemented("sqlite.backup()", "the SQLite online-backup API is not exported by this engine build."));
  }

  return {
    DatabaseSync,
    StatementSync,
    Session,
    constants: SQLITE_CONSTANTS,
    backup,
  };
}
