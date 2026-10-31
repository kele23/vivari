// Spike (OFFLINE, Wasm-free): node:sqlite must answer what real Node's answers, and two
// connections in two processes must not be able to corrupt one database.
//
// WHY THIS EXISTS. node:sqlite was not registered at all, so `require("node:sqlite")`
// threw at module load. That stopped pnpm 11 before it printed its version: its store
// index is a SQLite database it reaches through node:sqlite. The binding is now real
// (packages/runtime/node/bindings/sqlite.js, over the same wasm SQLite as bun:sqlite).
//
// Three tiers, all over node:fs with no kernel, which is what lets this run on every PR:
//
//   1. Differential. One script, run against the host's real node:sqlite and against
//      the SHIPPED binding, transcripts compared line by line. node:sqlite has a lot of
//      rules that are the opposite of bun:sqlite's (numbers bind as doubles, a 2^53+
//      integer throws rather than truncates, get() of nothing is undefined, a thrown
//      UDF error arrives as itself), and every one of them was found this way rather
//      than read off the docs. Real Node is the oracle. Divergences we cannot remove are
//      listed in DIVERGENT by case name, each with its reason, and the gate checks that
//      they still diverge, so a list entry cannot outlive the fact it records.
//   2. The lock table (packages/kernel-host/file-locks.js), as a state machine.
//   3. Two engines sharing one lock table, standing in for two processes. Without the
//      table the second writer silently loses the first one's row, which is exactly what
//      pnpm 11's CLI and its worker threads would do to the store index on every install.
//
//   run:  node scripts/spike-node-sqlite.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import util from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createSqliteEngine } from "../packages/runtime/builtins/bun-sqlite.js";
import { createSqliteBinding } from "../packages/runtime/node/bindings/sqlite.js";
import {
  FileLocks,
  serviceFileLock,
  LOCK_NONE,
  LOCK_SHARED,
  LOCK_RESERVED,
  LOCK_PENDING,
  LOCK_EXCLUSIVE,
} from "../packages/kernel-host/file-locks.js";
import { FsServer } from "../packages/kernel-host/fs-server.js";
import { PREFIX_ONLY } from "../packages/runtime/node/loader.js";
import { OP_FILE_LOCK, isFsOpcode } from "../packages/protocol/syscall.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

let hostSqlite = null;
try {
  hostSqlite = require("node:sqlite");
} catch {
  /* reported below */
}

const ENGINE_BYTES = fs.readFileSync(path.join(ROOT, "packages/runtime/vendor/sqlite/sqlite3.wasm"));

function makeHost(lock = null) {
  let engine = null;
  const host = {
    fs,
    path,
    cwd: () => process.cwd(),
    randomBytes: (n) => crypto.randomBytes(n),
    tmpDir: os.tmpdir(),
    lock,
    getEngine: () => engine || (engine = createSqliteEngine(ENGINE_BYTES, host)),
  };
  return host;
}
const ours = createSqliteBinding(() => makeHost());

// ---------------------------------------------------------------------------------------
// 1. Differential
// ---------------------------------------------------------------------------------------

const describe = (v) => util.inspect(v, { depth: 4, breakLength: Infinity, sorted: false });
const describeError = (e) =>
  `!! ${e && e.constructor ? e.constructor.name : typeof e} ${e && e.code} ${e && e.errcode} ` +
  `${e && e.errstr} ${JSON.stringify(e && e.message)}`;

function runScript(S, dir) {
  const lines = [];
  const show = (name, fn) => {
    try {
      lines.push([name, "=> " + describe(fn())]);
    } catch (e) {
      lines.push([name, describeError(e)]);
    }
  };
  const db = new S.DatabaseSync(":memory:");

  // binding and reading values
  show("exec", () => db.exec("CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT, c BLOB, d REAL); INSERT INTO t(b) VALUES ('x')"));
  show("run", () => db.prepare("INSERT INTO t(b,c,d) VALUES (?,?,?)").run("y", new Uint8Array([1, 2]), 1.5));
  show("get", () => db.prepare("SELECT * FROM t WHERE a=?").get(2));
  show("get none", () => db.prepare("SELECT * FROM t WHERE a=?").get(99));
  show("all", () => db.prepare("SELECT a,b FROM t").all());
  show("typeof bound", () =>
    db.prepare("SELECT typeof(?) a, typeof(?) b, typeof(?) c, typeof(?) d, typeof(?) e").get(1, 1.5, true, 3n, new Uint8Array(1)));
  show("bool", () => db.prepare("SELECT ? AS v").get(true));
  show("undefined", () => db.prepare("SELECT ?").get(undefined));
  show("symbol", () => db.prepare("SELECT ? AS v").get(1, Symbol("x")));
  show("object first", () => db.prepare("SELECT ? AS v").get({}));
  show("date first", () => db.prepare("SELECT ? AS v").get(new Date(0)));
  show("dataview", () => db.prepare("SELECT ? AS v").get(new DataView(new ArrayBuffer(2))));
  show("arraybuffer", () => db.prepare("SELECT ? AS v").get(new ArrayBuffer(2)));
  show("blob view offset", () => db.prepare("SELECT ? AS v").get(new Uint8Array([0, 1, 2, 3]).subarray(1, 3)));
  show("nan", () => db.prepare("SELECT ? AS v").get(NaN));
  show("float int", () => db.prepare("SELECT ? AS v").get(2 ** 60));
  show("big read", () => db.prepare("SELECT 9007199254740993 AS v").get());
  show("big bound", () => db.prepare("SELECT ? AS v").get(2n ** 62n));
  show("big too big", () => db.prepare("SELECT ? AS v").get(2n ** 64n));
  show("negative big", () => db.prepare("SELECT -9007199254740993 AS v").get());

  // parameters
  show("named bare", () => db.prepare("SELECT :x AS x, $y AS y, @z AS z").get({ x: 1, y: 2, z: 3 }));
  show("named prefixed", () => db.prepare("SELECT :x AS x").get({ ":x": 1 }));
  show("named unknown", () => db.prepare("SELECT :x AS x").get({ x: 1, z: 2 }));
  show("named missing", () => db.prepare("SELECT :x AS x, :y AS y").get({ x: 1 }));
  show("named + anon", () => db.prepare("SELECT :x AS x, ? AS y").get({ x: 1 }, 5));
  show("anon skips named", () => db.prepare("SELECT ? AS a, :n AS n, ? AS b").get({ n: 9 }, 1, 2));
  show("dup name", () => db.prepare("SELECT :x AS v, :x AS w").get({ x: 3 }));
  show("mixed prefix", () => db.prepare("SELECT :a AS v").get({ ":a": 1, a: 2 }));
  show("too many", () => db.prepare("SELECT ? AS x").get(1, 2));
  show("conflicting bare", () => db.prepare("SELECT :a AS v, $a AS w").get({ a: 1 }));
  show("bare off", () => {
    const st = db.prepare("SELECT :x AS v");
    st.setAllowBareNamedParameters(false);
    return st.get({ x: 1 });
  });
  show("unknown allowed", () => {
    const st = db.prepare("SELECT :x AS v");
    st.setAllowUnknownNamedParameters(true);
    return st.get({ x: 1, y: 2 });
  });

  // statement surface
  show("readBigInts", () => {
    const st = db.prepare("SELECT 5 AS v");
    st.setReadBigInts(true);
    return [st.get(), st.run()];
  });
  show("returnArrays", () => {
    const st = db.prepare("SELECT 5 AS v, 6 AS w");
    st.setReturnArrays(true);
    return [st.get(), st.all()];
  });
  show("setReadBigInts bad", () => db.prepare("SELECT 1").setReadBigInts(1));
  show("setReturnArrays bad", () => db.prepare("SELECT 1").setReturnArrays("x"));
  show("setAllowBare bad", () => db.prepare("SELECT 1").setAllowBareNamedParameters(1));
  show("setAllowUnknown bad", () => db.prepare("SELECT 1").setAllowUnknownNamedParameters(1));
  show("columns", () => db.prepare("SELECT a, b AS bee, 1+1 AS two FROM t").columns());
  show("columns ddl", () => db.prepare("CREATE TABLE IF NOT EXISTS z(a)").columns());
  show("sql text", () => {
    const st = db.prepare("SELECT ? AS v, ? AS w");
    st.get("it's", 2);
    return [st.sourceSQL, st.expandedSQL];
  });
  show("iterate", () => [...db.prepare("SELECT a FROM t").iterate()]);
  show("iterate args", () => [...db.prepare("SELECT ? AS v").iterate(7)]);
  show("iterator shape", () => {
    const it = db.prepare("SELECT 1 AS a").iterate();
    return [typeof it.next, typeof it.return, typeof it[Symbol.iterator], Object.prototype.toString.call(it), it.next(), it.next()];
  });
  show("iterator return", () => {
    const it = db.prepare("SELECT 1 AS a UNION SELECT 2").iterate();
    it.next();
    return [it.return(), it.next()];
  });
  show("run select", () => {
    const d = new S.DatabaseSync(":memory:");
    return d.prepare("SELECT 1").run();
  });
  show("stmt keys", () => Object.keys(db.prepare("SELECT 1")));
  show("stmt new", () => new S.StatementSync());
  show("row proto", () => Object.getPrototypeOf(db.prepare("SELECT 1 AS a").get()));

  // errors
  show("syntax", () => db.exec("SELEC 1"));
  show("constraint", () => db.exec("CREATE TABLE u(x UNIQUE); INSERT INTO u VALUES(1); INSERT INTO u VALUES(1)"));
  show("dqs default", () => db.prepare('SELECT "nope" AS v').get());
  show("fk default", () => db.prepare("PRAGMA foreign_keys").get());
  show("defensive default", () => {
    const d = new S.DatabaseSync(":memory:");
    d.exec("CREATE TABLE a(x); PRAGMA writable_schema=ON");
    return d.exec("UPDATE sqlite_schema SET sql='create table a(y)' WHERE name='a'");
  });
  show("defensive off", () => {
    const d = new S.DatabaseSync(":memory:", { defensive: false });
    d.exec("CREATE TABLE a(x); PRAGMA writable_schema=ON");
    return d.exec("UPDATE sqlite_schema SET sql='create table a(x)' WHERE name='a'");
  });
  show("dqs on", () => new S.DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true }).prepare('SELECT "x" AS v').get());
  show("fk off", () => new S.DatabaseSync(":memory:", { enableForeignKeyConstraints: false }).prepare("PRAGMA foreign_keys").get());
  show("prepare empty", () => db.prepare(""));
  show("prepare comment", () => db.prepare("-- nothing"));
  show("exec comment", () => db.exec("-- nothing"));
  show("prepare multi", () => db.prepare("SELECT 1; SELECT 2").all());
  show("exec ret", () => db.exec("SELECT 1"));
  show("exec arg", () => db.exec(5));
  show("prepare arg", () => db.prepare(5));

  // the database object
  show("ctor no new", () => S.DatabaseSync(":memory:"));
  show("ctor bad path", () => new S.DatabaseSync(5));
  show("ctor null byte", () => new S.DatabaseSync("a\0b"));
  show("ctor options", () => new S.DatabaseSync(":memory:", 5));
  show("timeout type", () => new S.DatabaseSync(":memory:", { timeout: "x" }));
  show("readOnly type", () => new S.DatabaseSync(":memory:", { readOnly: 1 }));
  show("defensive type", () => new S.DatabaseSync(":memory:", { defensive: 5 }));
  show("open:false", () => {
    const d = new S.DatabaseSync(":memory:", { open: false });
    const r = [d.isOpen];
    try {
      d.exec("select 1");
    } catch (e) {
      r.push(e.code, e.message);
    }
    d.open();
    r.push(d.isOpen);
    try {
      d.open();
    } catch (e) {
      r.push(e.code, e.message);
    }
    return r;
  });
  show("close twice", () => {
    const d = new S.DatabaseSync(":memory:");
    d.close();
    d.close();
  });
  show("stmt after close", () => {
    const d = new S.DatabaseSync(":memory:");
    const st = d.prepare("select 1");
    d.close();
    return st.get();
  });
  show("iterate after close", () => {
    const d = new S.DatabaseSync(":memory:");
    const it = d.prepare("select 1 union select 2").iterate();
    it.next();
    d.close();
    return it.next();
  });
  show("closed getters", () => {
    const d = new S.DatabaseSync(":memory:");
    d.close();
    const r = [d.isOpen];
    for (const f of [() => d.isTransaction, () => d.location(), () => d.prepare("select 1")]) {
      try {
        r.push(f());
      } catch (e) {
        r.push(e.code + " " + e.message);
      }
    }
    return r;
  });
  show("readOnly write", () => new S.DatabaseSync(":memory:", { readOnly: true }).exec("create table z(a)"));
  show("transaction state", () => {
    db.exec("BEGIN IMMEDIATE");
    const r = db.isTransaction;
    db.exec("COMMIT");
    return [r, db.isTransaction];
  });
  show("location memory", () => db.location());
  show("db keys", () => Object.keys(db));
  show("limits", () => ({ ...db.limits }));
  show("dispose", () => {
    const d = new S.DatabaseSync(":memory:");
    d[Symbol.dispose]();
    d[Symbol.dispose]();
    return [d.isOpen, typeof S.StatementSync.prototype[Symbol.dispose]];
  });
  show("serialize", () => {
    const d = new S.DatabaseSync(":memory:");
    d.exec("create table q(a); insert into q values(1)");
    const b = d.serialize();
    const e = new S.DatabaseSync(":memory:");
    e.deserialize(b);
    return [b instanceof Uint8Array, b.length, e.prepare("select * from q").all()];
  });
  show("readBigInts option", () => new S.DatabaseSync(":memory:", { readBigInts: true }).prepare("SELECT 1 AS v").get());
  show("returnArrays option", () => new S.DatabaseSync(":memory:", { returnArrays: true }).prepare("SELECT 1 AS v").get());
  show("bare option off", () => new S.DatabaseSync(":memory:", { allowBareNamedParameters: false }).prepare("SELECT :a AS v").get({ a: 1 }));
  show("unknown option on", () => new S.DatabaseSync(":memory:", { allowUnknownNamedParameters: true }).prepare("SELECT :a AS v").get({ a: 1, b: 2 }));
  show("extension gate", () => db.enableLoadExtension(true));
  show("constants", () => S.constants);
  show("module keys", () => Object.keys(S).sort());

  // user-defined functions and aggregates
  show("fn", () => {
    db.function("dbl", (x) => x * 2);
    return db.prepare("SELECT dbl(21) AS v").get();
  });
  show("fn throw", () => {
    db.function("bad", () => {
      throw new Error("boom");
    });
    return db.prepare("SELECT bad() AS v").get();
  });
  show("fn throw in exec", () => db.exec("SELECT bad()"));
  show("fn args", () => {
    db.function("ty", { varargs: true }, (...a) => a.map((x) => typeof x + (x instanceof Uint8Array ? ":u8" : "")).join(","));
    return db.prepare("SELECT ty(1, 1.5, 'a', x'01', NULL) AS v").get();
  });
  show("fn unsafe arg", () => {
    db.function("id", (x) => x);
    return db.prepare("SELECT id(9007199254740993) AS v").get();
  });
  show("fn bigint args", () => {
    db.function("tb", { useBigIntArguments: true }, (x) => typeof x);
    return db.prepare("SELECT tb(1) AS v").get();
  });
  show("fn returns", () => {
    db.function("r", (k) => [undefined, null, 1, 1.5, 2n, "x", new Uint8Array([7])][k]);
    return [0, 1, 2, 3, 4, 5, 6].map((k) => db.prepare("SELECT r(?) AS v, typeof(r(?)) AS t").get(k, k));
  });
  show("fn returns bool", () => {
    db.function("rb", () => true);
    return db.prepare("SELECT rb() AS v").get();
  });
  show("fn returns object", () => {
    db.function("ro", () => ({}));
    return db.prepare("SELECT ro() AS v").get();
  });
  show("fn returns promise", () => {
    db.function("rp", () => Promise.resolve(1));
    return db.prepare("SELECT rp() AS v").get();
  });
  show("fn returns huge bigint", () => {
    db.function("rh", () => 2n ** 64n);
    return db.prepare("SELECT rh() AS v").get();
  });
  show("fn arity", () => {
    db.function("ar", (a, b) => a + b);
    return db.prepare("SELECT ar(1) AS v").get();
  });
  show("fn redefined", () => {
    db.function("dd", () => 1);
    db.function("dd", () => 2);
    return db.prepare("SELECT dd() AS v").get();
  });
  show("fn bad name", () => db.function(5, () => 1));
  show("fn bad fn", () => db.function("x"));
  show("fn bad option", () => db.function("x", { varargs: 1 }, () => 1));
  show("agg", () => {
    db.aggregate("sumx", { start: 0, step: (acc, v) => acc + v });
    return db.prepare("SELECT sumx(a) AS v FROM t").get();
  });
  show("agg result", () => {
    db.aggregate("cnt", { start: () => [], step: (a, v) => (a.push(v), a), result: (a) => a.length });
    db.exec("CREATE TABLE n(x); INSERT INTO n VALUES (1),(2),(3)");
    return [db.prepare("SELECT cnt(x) AS v FROM n").get(), db.prepare("SELECT cnt(x) AS v FROM n WHERE 0").get()];
  });
  show("agg window", () => {
    db.aggregate("w", { start: 0, step: (a, v) => a + v, inverse: (a, v) => a - v });
    return db.prepare("SELECT w(x) OVER (ORDER BY x ROWS 1 PRECEDING) AS v FROM n").all();
  });
  show("agg throws", () => {
    db.aggregate("at", { start: 0, step: () => {
      throw new TypeError("step failed");
    } });
    return db.prepare("SELECT at(x) AS v FROM n").get();
  });
  show("agg no start", () => db.aggregate("q", { step: () => 1 }));
  show("agg no step", () => db.aggregate("q", { start: 0 }));

  // tag store
  show("tag store", () => {
    const tags = db.createTagStore(5);
    const v = [tags.get`SELECT ${5} AS v`, tags.all`SELECT ${"q"} AS v`, tags.run`INSERT INTO n VALUES (${4})`];
    return [v, tags.size, tags.capacity, tags.db === db, [...tags.iterate`SELECT x FROM n WHERE x > ${3}`]];
  });

  // files
  const file = path.join(dir, "a.db");
  show("file round trip", () => {
    const d = new S.DatabaseSync(file);
    d.exec("CREATE TABLE f(x); INSERT INTO f VALUES ('kept')");
    d.close();
    const e = new S.DatabaseSync(Buffer.from(file), { readOnly: true });
    const rows = e.prepare("SELECT x FROM f").all();
    e.close();
    return rows;
  });
  show("file url", () => {
    const d = new S.DatabaseSync(new URL("file://" + file));
    const rows = d.prepare("SELECT x FROM f").all();
    d.close();
    return rows;
  });
  show("readOnly missing", () => new S.DatabaseSync(path.join(dir, "missing.db"), { readOnly: true }));
  show("pnpm store pattern", () => {
    // What pnpm 11's StoreIndex does with every connection (worker.js, StoreIndex).
    const d = new S.DatabaseSync(path.join(dir, "index.db"));
    d.exec("PRAGMA busy_timeout=5000");
    d.exec("PRAGMA synchronous=NORMAL");
    d.exec("PRAGMA mmap_size=536870912");
    d.exec("PRAGMA cache_size=-32000");
    d.exec("PRAGMA temp_store=MEMORY");
    d.exec("PRAGMA wal_autocheckpoint=10000");
    d.exec("CREATE TABLE IF NOT EXISTS package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID");
    const set = d.prepare("INSERT OR REPLACE INTO package_index (key, data) VALUES (?, ?)");
    d.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < 50; i++) set.run("k" + i, new Uint8Array([i]));
    d.exec("COMMIT");
    const get = d.prepare("SELECT data FROM package_index WHERE key = ?");
    const keys = [];
    for (const row of d.prepare("SELECT key FROM package_index").iterate()) keys.push(row.key);
    const r = [get.get("k7"), keys.length, d.prepare("SELECT 1 FROM package_index WHERE key = ?").get("nope")];
    d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    d.exec("VACUUM");
    d.close();
    return r;
  });
  show("wal on a file", () => {
    const d = new S.DatabaseSync(path.join(dir, "wal.db"));
    const r = d.prepare("PRAGMA journal_mode=WAL").get();
    d.close();
    return r;
  });
  return lines;
}

// Cases whose answers we cannot make identical, and why. Each must STILL differ.
const DIVERGENT = {
  // Write-ahead logging needs a shared-memory VFS (xShmMap) and this one is iVersion 1;
  // SQLite answers with the mode actually in effect. Node's says "wal".
  "wal on a file": "no shared-memory VFS, so SQLite stays in DELETE journal mode",
  // The session extension is compiled in but not wired to this binding yet.
};

// node:sqlite changes a lot between Node lines (22 has no serialize, createTagStore or
// limits, binds booleans differently and orders run()'s keys the other way), so only a
// host on the line the runtime reports is an oracle for it. On any other host the
// differential is skipped and says so; VV_REQUIRE_SQLITE_ORACLE=1 (set by the CI step
// that runs this on that line) turns the skip into a failure, so the tier cannot go
// quietly unexercised.
const EMULATED = /version:\s*"v(\d+)\./.exec(
  fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/process.js"), "utf8"),
)[1];
const HOST = process.versions.node.split(".")[0];
const oracleOk = hostSqlite && HOST === EMULATED;

console.log("node:sqlite, ours against the host's:");
if (!oracleOk) {
  const why = !hostSqlite
    ? "the host has no node:sqlite"
    : `the host is Node ${HOST} and the runtime reports Node ${EMULATED}`;
  if (process.env.VV_REQUIRE_SQLITE_ORACLE === "1") ok(false, `differential needs a Node ${EMULATED} host: ${why}`);
  else console.log(`  - SKIPPED: ${why}; run on Node ${EMULATED} for the differential`);
} else {
  const dirHost = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vv-nsq-host-"));
  const dirOurs = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vv-nsq-ours-"));
  const theirs = runScript(hostSqlite, dirHost);
  const mine = runScript(ours, dirOurs);
  const norm = (s, dir) => s.split(dir).join("<dir>");
  let same = 0;
  for (let i = 0; i < theirs.length; i++) {
    const [name, a] = theirs[i];
    const b = mine[i] ? mine[i][1] : "<missing>";
    const equal = norm(a, dirHost) === norm(b, dirOurs);
    if (DIVERGENT[name]) {
      ok(!equal, `${name}: still differs (${DIVERGENT[name]})`);
      continue;
    }
    if (equal) same++;
    else {
      ok(false, `${name}\n      node : ${norm(a, dirHost)}\n      ours : ${norm(b, dirOurs)}`);
    }
  }
  ok(theirs.length === mine.length, `both runs produced ${theirs.length} lines`);
  ok(same + Object.keys(DIVERGENT).length === theirs.length, `${same} of ${theirs.length} cases identical to real node:sqlite`);
  fs.rmSync(dirHost, { recursive: true, force: true });
  fs.rmSync(dirOurs, { recursive: true, force: true });
}

// The things the differential cannot see, because Node has them and we refuse them.
{
  const db = new ours.DatabaseSync(":memory:", { allowExtension: true });
  db.enableLoadExtension(true);
  let e = null;
  try {
    db.loadExtension("/x.so");
  } catch (err) {
    e = err;
  }
  ok(e && e.code === "ERR_METHOD_NOT_IMPLEMENTED" && /dlopen/.test(e.message),
    "loadExtension refuses, naming the missing dlopen(3), instead of pretending to load");
  for (const [name, fn] of [["createSession", () => db.createSession()], ["applyChangeset", () => db.applyChangeset(new Uint8Array())], ["setAuthorizer", () => db.setAuthorizer(null)]]) {
    let err = null;
    try {
      fn();
    } catch (x) {
      err = x;
    }
    ok(err && err.code === "ERR_METHOD_NOT_IMPLEMENTED" && err.message.includes(name), `${name} says it is not implemented here`);
  }
}

// ---------------------------------------------------------------------------------------
// 2. The lock table
// ---------------------------------------------------------------------------------------

console.log("the lock table:");
{
  const L = new FileLocks();
  const P = "/db";
  ok(L.acquire(P, "a", 1, LOCK_SHARED) === LOCK_SHARED && L.acquire(P, "b", 1, LOCK_SHARED) === LOCK_SHARED,
    "two readers hold SHARED together");
  ok(L.acquire(P, "a", 1, LOCK_RESERVED) === LOCK_RESERVED, "one of them takes RESERVED");
  ok(L.acquire(P, "b", 1, LOCK_RESERVED) === LOCK_SHARED, "…and the other cannot, and is told it still holds SHARED");
  ok(L.checkReserved(P, "b", 1) && !L.checkReserved(P, "a", 1), "check-reserved sees the OTHER owner's RESERVED only");
  ok(L.acquire(P, "a", 1, LOCK_EXCLUSIVE) === LOCK_PENDING,
    "EXCLUSIVE with a reader present stops at PENDING (kept, so the writer is not starved)");
  ok(L.acquire(P, "c", 1, LOCK_SHARED) === LOCK_NONE, "a NEW reader is refused while a writer holds PENDING");
  L.release(P, "b", 1, LOCK_NONE);
  ok(L.acquire(P, "a", 1, LOCK_EXCLUSIVE) === LOCK_EXCLUSIVE, "once the reader leaves, EXCLUSIVE is granted");
  ok(L.acquire(P, "b", 1, LOCK_SHARED) === LOCK_NONE, "nobody reads during EXCLUSIVE");
  L.release(P, "a", 1, LOCK_SHARED);
  ok(L.acquire(P, "b", 1, LOCK_SHARED) === LOCK_SHARED, "after the commit drops to SHARED, readers are back");
  L.acquire(P, "a", 1, LOCK_RESERVED);
  ok(L.acquire(P, "a", 2, LOCK_SHARED) === LOCK_SHARED && L.acquire(P, "a", 2, LOCK_RESERVED) === LOCK_SHARED,
    "two connections in ONE process are separate owners and lock each other out");
  L.releaseClient("a");
  ok(L.acquire(P, "b", 1, LOCK_RESERVED) === LOCK_RESERVED, "a process going away releases all of its locks");
  L.releaseClient("b");
  L.releaseClient("c");
  ok(L.files.size === 0, "and an unlocked database leaves nothing behind in the table");
  ok(L.acquire("/x", "a", 1, LOCK_RESERVED) === LOCK_NONE && L.files.size === 0,
    "RESERVED without SHARED is refused, and a refused first request leaves no entry");

  // Through the FS worker's real dispatch, the way a syscall reaches it.
  const server = new FsServer(null);
  const call = (client, owner, op, level) => serviceFileLock(server.fileLocks, client, "/app/x.db", owner, op, level);
  call(1, 7, 0, LOCK_SHARED);
  call(1, 7, 0, LOCK_RESERVED);
  ok(call(2, 7, 2, 0) === 1, "FsServer answers check-reserved for another client (same owner id, other process)");
  server.unregister(1);
  ok(call(2, 7, 2, 0) === 0, "FsServer.unregister releases a dead process's locks");
  ok(OP_FILE_LOCK === 39 && isFsOpcode(OP_FILE_LOCK), "OP_FILE_LOCK routes to the File System Worker");
}

// ---------------------------------------------------------------------------------------
// 3. Two processes, one database
// ---------------------------------------------------------------------------------------

console.log("two connections in two 'processes':");
function twoWriters(withLocks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-nsq-lock-"));
  const file = path.join(dir, "shared.db");
  const table = new FileLocks();
  const lockFor = (client) => (withLocks ? (p, owner, op, level) => serviceFileLock(table, client, p, owner, op, level) : null);
  const A = createSqliteBinding(() => makeHost(lockFor("A")));
  const B = createSqliteBinding(() => makeHost(lockFor("B")));
  const a = new A.DatabaseSync(file);
  const b = new B.DatabaseSync(file);
  a.exec("CREATE TABLE r(who TEXT)");
  b.prepare("SELECT count(*) AS n FROM r").get(); // B now has the schema cached
  const out = { busy: null };
  a.exec("BEGIN");
  a.exec("INSERT INTO r VALUES ('a')");
  b.exec("BEGIN");
  try {
    b.exec("INSERT INTO r VALUES ('b')");
  } catch (e) {
    out.busy = e;
  }
  a.exec("COMMIT");
  try {
    b.exec(out.busy ? "ROLLBACK" : "COMMIT");
  } catch {
    /* B's transaction is gone either way */
  }
  if (out.busy) {
    b.exec("INSERT INTO r VALUES ('b')");
  }
  const c = new A.DatabaseSync(file);
  out.rows = c.prepare("SELECT who FROM r ORDER BY who").all().map((r) => r.who);
  for (const d of [a, b, c]) d.close();
  out.leftover = table.snapshot();
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
{
  const locked = twoWriters(true);
  ok(locked.busy && locked.busy.code === "ERR_SQLITE_ERROR" && (locked.busy.errcode & 0xff) === 5,
    `with the lock table, the second writer is told SQLITE_BUSY (${locked.busy && locked.busy.message}), which pnpm retries`);
  ok(JSON.stringify(locked.rows) === '["a","b"]', `…and both rows survive (${JSON.stringify(locked.rows)})`);
  ok(locked.leftover.length === 0, "…and closing every connection leaves no lock held");
  const unlocked = twoWriters(false);
  ok(!unlocked.busy && JSON.stringify(unlocked.rows) !== '["a","b"]',
    `without it, both writers 'succeed' and a committed row is lost (${JSON.stringify(unlocked.rows)}): the bug this table exists for`);
}

// busy_timeout really waits: a reader that lets go after 200 ms is outlasted, not raced.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-nsq-busy-"));
  const file = path.join(dir, "busy.db");
  const table = new FileLocks();
  const A = createSqliteBinding(() => makeHost((p, o, op, l) => serviceFileLock(table, "A", p, o, op, l)));
  const a = new A.DatabaseSync(file, { timeout: 300 });
  a.exec("CREATE TABLE t(x)");
  // Hold RESERVED from a fake second process, released only by the clock.
  table.acquire(file, "ghost", 1, LOCK_SHARED);
  table.acquire(file, "ghost", 1, LOCK_RESERVED);
  const t0 = Date.now();
  let err = null;
  try {
    a.exec("INSERT INTO t VALUES (1)");
  } catch (e) {
    err = e;
  }
  const waited = Date.now() - t0;
  ok(err && (err.errcode & 0xff) === 5 && waited >= 250,
    `busy_timeout spends its budget in real time before giving up (${waited} ms of 300), rather than returning at once`);
  table.releaseClient("ghost");
  a.exec("INSERT INTO t VALUES (1)");
  ok(a.prepare("SELECT count(*) AS n FROM t").get().n === 1, "…and succeeds once the other process lets go");
  a.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------

console.log("registration:");
{
  ok(PREFIX_ONLY.has("sqlite"), "sqlite is a node:-only builtin, so require('sqlite') still reaches the npm package");
  const loaderSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/node/loader.js"), "utf8");
  ok(/sqlite: sqliteFactory/.test(loaderSrc), "the loader serves lib/sqlite.js");
  const indexSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/index.js"), "utf8");
  ok(/lock: typeof syscalls\.fileLock === "function"/.test(indexSrc),
    "the runtime hands the SQLite host the FS worker's lock table");
  ok(/sqliteHost: getSqliteHost/.test(indexSrc.slice(indexSrc.indexOf("createBunRuntime({"))),
    "…and gives bun:sqlite the same host, so the two share one engine and one set of locks");
}

console.log(failed === 0 ? "\nnode:sqlite: all checks passed" : `\nnode:sqlite: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
