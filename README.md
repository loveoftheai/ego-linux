# ego-linux — unofficial Linux port of ego-browser

> **Unofficial community port. Not affiliated with, endorsed by, or sponsored by CitroLabs.**
> `ego-lite` and `ego-browser` are projects of CitroLabs (https://github.com/citrolabs/ego-lite).
> This repository contains an original Linux implementation of the `ego-browser` CLI plus a
> CDP-based virtual binding layer that drives a stock Chromium. It reuses CitroLabs'
> MIT-licensed `ego-browser` TypeScript runtime (the SDK bundle under `sdk/` / `vendor/`)
> exactly as its license permits, with attribution below. No proprietary CitroLabs binaries,
> assets, or Chromium builds are included.

## What it is

`ego-browser` is the command-line harness that lets AI agents drive a browser through a
stable set of page tools (`snapshot`, `click`, `fill`, `navigate`, `capture`, …) while
sharing the user's real logged-in sessions inside isolated "spaces". The official
implementation is macOS-only. This port brings the same CLI surface and snapshot format
to Linux, using an ordinary Chromium plus a Node-side virtual `globalThis.ego` binding
layer over CDP.

Verified against the upstream interface (October 2026, see `docs/implementation-notes.zh-CN.md`):

- CLI command set and parameters (`help`, `skill`, `nodejs`, `import`, `upgrade`, `--version`)
- Snapshot format, including `@ref` semantics, frame ids, and `loc=url=` locators
- Space isolation (shared cookie jar within a profile, isolation across profiles)
- Real login-state attach via profile import
- Skill auto-install (`~/.agents/skills/ego-browser`)
- Full end-to-end tasks (navigate → snapshot → fill → click → evaluate)

## Version mapping

| This port | Tracks |
| --- | --- |
| `0.6.0.16-linux.1` (`VERSION`) | ego-lite macOS app `0.6.0.16` behavior + upstream SDK `0.1.0` |
| `0.6.0.16-linux.2` (`VERSION`) | same app behavior line + upstream repo tag `v2.2.0-beta.5` (SDK package version still `0.1.0`); Linux port patch re-applied, see `docs/implementation-notes.zh-CN.md` |
| `0.6.0.16-linux.3` (`VERSION`) | same app behavior line + upstream `dev` head `4471deb` (4 commits past `v2.2.0-beta.5`; SDK package version still `0.1.0`); Linux port patch re-applied, see `docs/implementation-notes.zh-CN.md` |
| `0.6.0.16-linux.4` (`VERSION`) | linux.3 + Justin's `3d6f570` CDP-masking fallback re-applied at SDK source level (was lost in the linux.3 bundle rebuild, which only touched `sdk/index.js` in his commit); see `docs/implementation-notes.zh-CN.md` |
| `0.6.0.16-linux.5` (`VERSION`) | linux.4 + upstream `dev` head `b201124` (docs only for the SDK: SKILL.md screenshot-timeout/canvas fallback + handOff scope notes, clearing-state.md handoff wording; SDK package version still `0.1.0`); Linux port patches re-applied at source level, see `docs/implementation-notes.zh-CN.md` |
| `0.6.0.16-linux.6` (`VERSION`) | linux.5 + upstream `dev` head `bbd103c` (PR #649 dry-run state + PR #645 named permission prompts: clipboard/local-network/storage-access/window-management/local-fonts/permission-prompt; SKILL.md + `waitForFunction` resolves-to-`true` documentation; SDK package version still `0.1.0`); Linux port patches re-applied at source level, see `docs/implementation-notes.zh-CN.md` |
| `-linux.N` suffix | Linux-port revision, bumped on every port-side change |

This repository tracks upstream `citrolabs/ego-lite` and is updated when upstream changes.
See "Sync policy" below.

## Quickstart

Requirements: Node.js >= 22 and a Chromium or Chrome build (headless shell works for most
tasks; headed mode needs a full Chrome build).

```sh
git clone https://github.com/loveoftheai/ego-linux.git
cd ego-linux
./bin/ego-browser --version
./bin/ego-browser skill          # print the usage guide
./bin/ego-browser nodejs -e 'await ego.goto("https://example.com"); console.log(await ego.snapshot())'
```

Install the agent skill into your agent setup:

```sh
./bin/ego-browser skill --help   # see skill installation options
```

Import real login state from an existing browser profile:

```sh
./bin/ego-browser import --help
```

## Layout

```
.
├── ego-browser            # CLI launcher (Node, original implementation)
├── bin/ego-browser         # sh wrapper -> ../ego-browser
├── sdk/                    # MIT upstream SDK bundle (built from citrolabs/ego-lite)
├── vendor/ego-browser/     # vendored copy of the same SDK bundle (offline fallback)
├── src/                    # original Linux binding layer
│   ├── chromium.js        # Chromium process management (shared instance)
│   ├── cdp-transport.js   # CDP WebSocket transport
│   ├── ego-bindings.js    # globalThis.ego virtual binding layer (spaces, tabs, snapshot, CDP)
│   ├── snapshot.js        # snapshot engine (AX tree -> upstream-format text tree)
│   ├── browser-pool.js
│   ├── import-profiles.js
│   ├── first-run.js
│   └── proxy-relay-daemon.js
├── tests/ test-scripts/ test-fixtures/   # smoke + end-to-end checks
├── docs/implementation-notes.zh-CN.md     # detailed reverse-engineering notes (Chinese)
└── VERSION                 # port version
```

`sdk/` is a materialized copy of the upstream SDK bundle (same content as
`vendor/ego-browser/dist/out/`). It is regenerated from upstream on every sync; do not
hand-edit it — port changes belong in `src/` and `ego-browser`.

## Relationship, attribution, and licensing

- **This port's original code** (`ego-browser`, `bin/`, `src/`, tests, docs) is MIT
  licensed — see `LICENSE`. Copyright (c) 2026 ego-linux contributors.
- **Upstream runtime** (`sdk/`, `vendor/ego-browser/`): the `ego-browser` TypeScript
  runtime from CitroLabs' [`ego-lite`](https://github.com/citrolabs/ego-lite), MIT
  licensed, (c) CitroLabs. Included here as a build artifact, unmodified except for
  the Linux port's documented patches (see implementation notes).
- **No affiliation.** This is an independent reimplementation from static analysis of
  the public interface. It is not a CitroLabs product, and nothing here implies
  CitroLabs' endorsement.
- **No proprietary material.** No macOS binaries, no extracted app assets, no Chromium
  fork builds are included. Chromium itself is not bundled; bring your own build.

## Known gaps (non-blocking)

- `animationHighlightMouseToPosition` is an empty implementation in headless mode.
- `includeActionMarks` is not implemented.
- Headed mode requires a full Chrome build.

## Sync policy

Upstream is checked daily. When `citrolabs/ego-lite` advances (main line or a newer
release/beta tag), the port is updated to match — runtime bundle rebuilt, binding-layer
behavior re-aligned, verification re-run — and the result is pushed here. A sync that
fails verification is not pushed; the failure is reported instead.
