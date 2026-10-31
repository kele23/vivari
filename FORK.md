# Fork notes

This repository is [`kele23/vivari`](https://github.com/kele23/vivari), a fork of
[`maitrungduc1410/vivari`](https://github.com/maitrungduc1410/vivari) (MIT). `facilis/main`
is `upstream/master` plus a small, deliberate delta. Keep the delta small: generic fixes go
upstream as small PRs, everything else is justified and recorded here.

## Policy (2026-10-31)

- **Upstream PRs: simple, self-contained fixes only.** Features that change the public SDK
  surface are discussed in an upstream issue first, and stay fork-only until then.
- **Fork-only, by decision:**
  - `BootOptions.deferRestoreRoots` / `vv-restore-roots` (`54d4dfa`)
  - `BootOptions.deferCacheFiles` (`50888b8`)
  - pnpm config moved out of the base process environment (`a3caed5`) — it matters only
    with the vendored npm 12 pin, which upstream does not carry.
- **No downstream-specific code in this repository.** Product templates, assets, probes or
  branding belong to the downstream product, which pins this fork as a submodule.
- Fork-only commits keep changesets while they touch `@vivari/core`.

## Upstream work

- [#29](https://github.com/maitrungduc1410/vivari/pull/29) — `fix(runtime): skip comments
  between export and its declaration` (`8be8a96`, branch `fix/esm-comment-after-export`).
- [#30](https://github.com/maitrungduc1410/vivari/pull/30) — `fix(vendor): rebuild a pack whose
  stamped version no longer matches` (`b7eb616`, branch `fix/vendor-stale-pack-version`).
- Both branch from upstream `master` at `890c5f0` (the v1.2.0 line).
- `8754dd5` cannot go upstream alone: it fixes `hydrate()`, which only exists after
  `54d4dfa`.
- `a34c205` (npm 12.2.1) is a chore coupled to `a3caed5`; it is also an incomplete bump — the
  version gates in `scripts/spike-npm.mjs` / `scripts/spike-npm-studio.mjs` and the vendor
  provisioning in `scripts/run-spikes.mjs` still say 10.9.2.

## Removed fork-only work

- `e2f4246` (template `assets`) is reverted: it existed only for the downstream product's
  local-tarball templates and had no contract, consumer, test or changeset here. A downstream
  embedder can pass bytes through the create message's `files` (`writeFilesBatch` already
  accepts them).

## Syncing with upstream

```sh
git fetch upstream
git rebase upstream/master      # fork-only commits stay on top
npm run spikes:offline          # after npm install; Wasm spikes need npm run build
```

Upstream moved to `890c5f0` on 2026-10-31 (release/v1.2.0 created), so `facilis/main` is
behind until the next realignment. When rebasing, drop `8be8a96`/`b7eb616` if their PRs
merged, and keep `e2f4246` out of the replay (its revert commit becomes empty and is dropped
too).
