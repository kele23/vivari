# Fork notes

This repository is [`kele23/vivari`](https://github.com/kele23/vivari), a fork of
[`maitrungduc1410/vivari`](https://github.com/maitrungduc1410/vivari) (MIT). `facilis/main`
is `upstream/master` plus a small, deliberate delta. Keep the delta small: generic fixes go
upstream as small PRs, everything else is justified and recorded here.

## Policy (2026-10-31)

- **Upstream PRs: simple, self-contained fixes only.** Features that change the public SDK
  surface are discussed in an upstream issue first, and stay fork-only until then.
- **Fork-only, by decision:**
  - `BootOptions.deferRestoreRoots` / `vv-restore-roots` (`8fd62fe`)
  - `BootOptions.deferCacheFiles` (`7725413`)
  - pnpm config moved out of the base process environment (`c20e0e9`) — the
    `npm_config_*` names pnpm reads are npm's too, so every other process inherited them
    (npm warns about unknown config, and a future major turns that warning into an error).
    Independent of which npm is vendored.
  - hostful `file:` URL recovery in `fileURLToPath` / `Bun.fileURLToPath` / `Bun.file(URL)`
    (`packages/runtime/node/internal/url.js`, `builtins/bun.js`, `builtins/bun-file.js`) — the
    one deliberate deviation from Node, which throws on posix. Chromium's `file:` parser is
    platform-dependent (`url/url_parse_file.cc` has a WIN32 UNC branch), so
    `"file:" + "/home/user/x"` is `file://home/user/x` on Chrome/Windows; in this VFS a host
    can only be the first path segment that parser promoted, so it is put back.
- **No downstream-specific code in this repository.** Product templates, assets, probes or
  branding belong to the downstream product, which pins this fork as a submodule.
- **Scope: the whole project except `packages/studio`.** The Studio IDE app is the downstream
  product's business: it keeps its own fork of it (`ide/` in `facilis-dev/facilis`) and its
  own copy of the preview Service Worker (`ide/public/sw.js`). One coupling to know —
  `@vivari/core` vendors `packages/studio/public/sw.js` into `dist/assets/sw.js` at build
  time, so the preview SW ships with core even though its canonical copy lives in studio, which
  makes a preview-SW fix IDE-side **by decision, not by architecture**.
- **Signalling the downstream means a GitHub issue in `facilis-dev/facilis`, never a change to
  its files.** A finding that belongs to the IDE is reported there (diagnosis, repro, design,
  patch in the body) and implemented there; this working tree, the downstream's working tree
  and the submodule worktree are all left alone.
- Fork-only commits keep changesets while they touch `@vivari/core`.

## Upstream work

- [#29](https://github.com/maitrungduc1410/vivari/pull/29) — `fix(runtime): skip comments
  between export and its declaration`. **Merged**; the fork's copy (`c9a9ecc`) drops out on
  rebase.
- [#30](https://github.com/maitrungduc1410/vivari/pull/30) — `fix(vendor): rebuild a pack whose
  stamped version no longer matches` (branch `fix/vendor-stale-pack-version`, based on
  `upstream/master`). Open, and it is only the stale-pack guard: `NPM_VERSION` is back to
  10.9.2 in that branch after the maintainer's review.
- [#31](https://github.com/maitrungduc1410/vivari/pull/31) / [#32](https://github.com/maitrungduc1410/vivari/pull/32) —
  `fix(runtime): never let a relative path become a file URL host`, merged and then reverted
  upstream. Superseded by #35.
- [#35](https://github.com/maitrungduc1410/vivari/pull/35) — `fix(runtime): keep file: URLs
  host-free, and recover the path when a parser adds one` (branch `fix/file-url-host-v2`,
  based on `upstream/master`). Restores #31's content, applies its review feedback (a literal
  `%` in `pathToFileURL`), and adds the hostful-`file:` recovery recorded above; the Windows
  reporter confirmed the fix on their machine. When it merges, drop the matching fork commits
  and the two `file-url-*` changesets on the next rebase.
- Rebased on `upstream/master` (`a9e3aac`, 2026-10-31, after #29 merged and #31 was reverted).
- `1fc1094` cannot go upstream alone: it fixes `hydrate()`, which only exists after
  `8fd62fe`.
- npm 12 is **not** in this fork: `c8ae8ed` + `9aa7682` (the 12.2.1 pin, its gates and its
  vendor instructions) are reverted in `revert(vendor): keep the vendored npm at 10.9.2`. The
  upstream reviewer asked for exactly that on PR #30 — an npm major bump is not part of a
  pack-version fix, and it "deserves its own PR with the spikes run against it". So npm 12
  comes back as its own change, with `spike-npm`/`spike-npm-studio` and the template spikes
  run on 12 first.

## Removed fork-only work

- `e2f4246` (template `assets`) is reverted: it existed only for the downstream product's
  local-tarball templates and had no contract, consumer, test or changeset here. A downstream
  embedder can pass bytes through the create message's `files` (`writeFilesBatch` already
  accepts them).

## Downstream (Facilis) work

Reported there as issues, never implemented here:

- [#4](https://github.com/facilis-dev/facilis/issues/4) — preview Service Worker: a reload can
  serve the other IDE tab's project once Chrome evicts the idle worker. The routing state is in
  SW memory only (`frameKernel`, `kernelByToken`, `kernelHostIds`, per-tab keep-prefix) and
  nothing re-announces an open page (`vv-kernel-host` is sent at registration and on
  `controllerchange`, not per `listen`), so after an eviction every preview request falls back
  to `pickKernelClient`; with two tabs both serving 5173 the wrong one answers 200. The issue
  carries the diagnosis, the repro, the design and a patch against `ide/public/sw.js`. No change
  kept here (scope: `packages/studio`); the spike work that gated it was reverted with it.

## Branch hygiene

The five `fix/*` branches merged upstream (PRs #19–#23) and the `facilis/pre-v1.1.5`
pre-rebase backup were deleted from `origin` on 2026-10-31. `facilis/main`, `master` and
the three open-PR branches remain; delete those when their PRs merge.

## Syncing with upstream

**This is a standing task, not a one-off: realign after every batch of changes and whenever
`upstream/master` moves.** `master` must stay exactly at `upstream/master` (it is the sync
base, nothing is committed on it), and `facilis/main` must be rebased on top of it — the
downstream product pins this branch, so a stale fork means the fix it is testing may not be in
the tree. Replay drops a fork commit whose patch upstream already merged; that is the signal
the PR landed.

```sh
git fetch upstream
git branch -f master upstream/master          # master tracks upstream exactly
git checkout facilis/main
git rebase upstream/master                     # fork-only commits stay on top
node scripts/spike-esm.mjs                     # the offline gates that need no install
node scripts/spike-bun-offline.mjs
npm run spikes:offline                         # after npm install; Wasm spikes need npm run build
git push --force-with-lease origin facilis/main
```

Realigned onto `upstream/master` (`a9e3aac`) on 2026-10-31: #29's merge dropped the fork's
copy of it, #31's revert dropped nothing (the fork never carried the throw), and the 18
remaining fork-only commits were replayed on top.

Upstream `v1.2.0` is itself red in CI: `toolchain-gate`/`toolchain-floor` fail in the
`ci-tiers` spike (the `needsWasm` spike-wiring check), the same failure as on `master` at
`9c87dec`, so it is not caused by this fork's changes.
