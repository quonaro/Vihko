# Contributing to Vihko

Thanks for taking the time to look at the code. Vihko is a small, opinionated project:
an Android-first sketching app where the point is how the ink feels, not how many features
fit in a tray. Contributions that respect that are welcome.

Before writing code, skim [AGENTS.md](AGENTS.md) — it is the architecture and conventions
document, and it is kept up to date. If a change makes it wrong, update it in the same PR.

## Reporting a bug

Open an issue with:

- app version (shown in `Settings → Version`, or the release tag),
- device and Android version,
- what you did, what you expected, what happened,
- a screenshot or a screen recording if the problem is visual,
- `adb logcat | grep -i vihko` output for crashes.

## Proposing a feature

Open an issue first. The app deliberately has a narrow surface: a notebook, ink tools,
layers, a shelf. Cloud sync, accounts, social features and "AI magic" are out of scope for
now. If you want to build something big, agree on the shape of it before spending a
weekend on it.

## Setting up

Requires Node 24 + pnpm, Go 1.27 (the WASM ink engine), and for Android builds JDK 21 +
the Android SDK. Building iOS needs macOS.

```sh
lota install      # or: pnpm install
lota dev web      # vite on :7357, builds the WASM engine first
lota build apk    # debug APK, installs as vihko.app.dev next to the release
lota cap android  # sync + open Android Studio
```

`lota` is the project's task runner ([github.com/quonaro/lota](https://github.com/quonaro/lota));
the tasks are declared in [`lota.yml`](lota.yml) and every one of them is a thin wrapper
around a `pnpm` script, so `pnpm dev`, `pnpm build` and friends work just as well.

`lota dev android` gives you live reload inside the app's WebView on a connected device or
emulator.

## Before you open a PR

Everything below must pass — CI runs exactly these four jobs:

```sh
lota test         # pnpm test (Vitest) + pnpm test:go (Go)
pnpm typecheck    # vue-tsc --noEmit
pnpm lint         # Biome: lint + format check
```

One test file:

```sh
pnpm test src/ink/engine.test.ts
cd engine && go test -run TestStroke ./...
```

Apply formatting with `pnpm lint:fix` instead of hand-fixing style.

## What gets a PR rejected

- **Behaviour change without tests.** New behaviour comes with tests; a fix comes with a
  test that fails before it. This is not negotiable here — the ink engine and the storage
  layer are covered precisely because regressions there are invisible until a user loses a
  drawing.
- **Engine changes with only one side updated.** `engine/ink.go` (Go→WASM) and
  `src/ink/engine.ts` (JS fallback) must stay in lockstep: implement in both, and keep the
  matching assertions in `engine/ink_test.go` and `src/ink/engine.test.ts` in sync. The
  fallback is not a stub, it is what runs in browsers and in tests.
- **New UI strings added to one locale only.** Messages live in `src/i18n.ts` with `en`
  and `ru` blocks — add the key to both.
- **Desktop-first layout.** Design and verify on a phone viewport first, then adapt to
  larger screens.
- **Files over the size limits.** Keep Go files around 300 lines (hard limit 400) and Vue
  SFCs around 600 (hard limit 700); split by responsibility instead of growing a file.
- **Unrelated churn.** No repo-wide reformatting, no "while I was here" refactors, no
  dependency bumps mixed into a feature.
- **Code from Paper, or from a decompiled/disassembled build of it.** Vihko is a clean-room
  reimplementation built from public descriptions and screenshots. If you contribute,
  contribute your own code.

## Style

- Biome owns formatting: single quotes, no semicolons, trailing commas, two-space indent
  (`biome.json`).
- TypeScript is strict; prefer explicit types at module boundaries, `type` imports for
  types only.
- Commits follow Conventional Commits with a scope, matching the existing history:
  `feat(canvas): …`, `fix(ink): …`, `refactor(tray): …`, `style(settings): …`.
  Scopes in use: `android`, `canvas`, `shelf`, `ink`, `render`, `tray`, `settings`,
  `persistence`, `covers`, `i18n`, `log`, `dbg`.
- One logical change per commit, and keep the history linear (rebase on `main`, don't merge
  it in).

## Where things live

| Path                                 | Contents                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `engine/`                            | Go→WASM ink engine: stroke model in `ink.go`, pixel kernels (fill, blur, wet mixing) in `px.go`, JS bindings in `main.go` |
| `src/ink/`                           | Stroke rendering, layers, raster ops, shapes, RYB colour mixing, the JS engine fallback                                   |
| `src/three/`                         | three.js shelf and book spread; pure layout math is separated and unit tested                                             |
| `src/store.ts`, `src/persistence.ts` | Journals/pages/strokes model, undo/redo, per-row storage (SQLite / IndexedDB)                                             |
| `src/views/`                         | Shelf → journal → canvas screens                                                                                          |
| `src/components/`                    | Docked panels, dialogs, sliders, colour picker                                                                            |
| `src/i18n.ts`                        | English and Russian messages                                                                                              |
| `docs/screenshots/`                  | Screenshots used by the README                                                                                            |

## Screenshots

If you change something visible in the UI, refresh the affected image in
`docs/screenshots/`: phone viewport 412×915 at 2×, English UI, saved as WebP. Keep them
small — the whole folder is under 200 KB.

## License

Vihko is MIT-licensed (see [LICENSE](LICENSE)). By opening a pull request you agree that
your contribution is licensed under the same terms. There is no CLA and no copyright
assignment to sign.
