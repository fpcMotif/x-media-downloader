# Tooling + Edge-Case Setup — X Media Downloader

Date: 2026-06-07
Status: Verified against the real repo (read-only tool runs + vitest harness). Adversarial verdicts applied; where a verdict refuted a research claim, the correction is reflected below.

Repo: `/Users/martinfan/devv/xediadownloader` (WXT MV3 extension, TS + Preact + Effect v4).

## TL;DR

- **typecheck**: switch `tsc --noEmit` → `tsgo --noEmit`. Byte-identical diagnostics on this repo, ~7x faster. Keep `wxt prepare &&` in front.
- **lint**: `oxlint` (1.68.0). Default correctness-only ruleset already passes clean (exit 0). A `.oxlintrc.json` is added to harden it (suspicious/perf as warn, Preact/Effect false positives suppressed). It does NOT yet exist in the repo — it must be created.
- **format**: `oxfmt` (0.53.0). A `.oxfmtrc.json` is **mandatory** — without it oxfmt defaults to double-quote + semicolon and rewrites every file (the opposite of the project's single-quote/no-semicolon style). Config does NOT yet exist — it must be created.
- **Effect LSP**: `@effect/language-service` is an editor-only tsserver plugin. It is **not currently wired** into any tsconfig; it does not affect `tsc`/`tsgo` CLI typecheck. To enforce Effect rules in CI use the standalone `effect-language-service diagnostics` CLI (the patch route cannot reach tsgo).
- **X media audit**: `resolveTweetMedia` + `detectFromJson` produce correct count/type/url/index for every asked combo (verified via vitest). No correctness bug. One caveat: skipped entries leave non-contiguous output indices.

## Current state (verified facts, read-only)

- No formatter/linter config exists at repo root: no `.oxlintrc*`, `.oxfmtrc*`, `.prettierrc*`, `.editorconfig`. None tracked in git, ever.
- Local binaries (use these, NOT global PATH which is older 0.45.0/1.66.0):
  - `node_modules/.bin/oxlint` → **1.68.0**
  - `node_modules/.bin/oxfmt` → **0.53.0**
  - `node_modules/.bin/tsgo` → **7.0.0-dev.20260607.1** (`@typescript/native-preview`)
  - `node_modules/.bin/tsc` → **6.0.3** (TypeScript 6)
- `package.json` scripts today: `dev`, `build`, `prepare`, `typecheck` (= `wxt prepare && tsc --noEmit`), `test`, `test:watch`. No `lint`/`fmt`.
- Root `tsconfig.json` extends `./.wxt/tsconfig.json`; sets strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, jsx react-jsx / jsxImportSource preact, skipLibCheck. **No `compilerOptions.plugins`** anywhere (root, `.wxt/tsconfig.json`, `wxt.config.ts` — the only `plugins` in the tree are Vite plugins).
- `.gitignore` already ignores `node_modules/`, `.output/`, `.wxt/`, `dist/`, `study/`; oxfmt auto-respects `.gitignore`.

---

## 1. TypeScript typecheck — adopt tsgo (TypeScript 7 native preview)

**Verdict: CONFIRMED.** `bunx tsgo --noEmit` is a safe drop-in for `tsc --noEmit` on this repo.

- Both compilers exit 0 with **zero** diagnostics on src today.
- Diagnostic parity proven by injecting identical errors (strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes) into a throwaway `/tmp` file: both produced byte-identical error codes/positions — `TS2322`, `TS2322`, `TS18048` (and separately `TS2375` for exactOptionalPropertyTypes). The only cosmetic differences: path-prefix formatting and the failure exit code (tsc=2 vs tsgo=1); both non-zero so pass/fail script semantics are preserved.
- Config chain (`extends: ./.wxt/tsconfig.json`) resolves identically — `diff` of `--showConfig` differs only in key ordering. All 8 path aliases, `resolveJsonModule`, `moduleResolution: bundler`, jsx settings are honored. `study/`, `.output`, `node_modules` correctly excluded.
- Timing: tsgo ~0.11s vs tsc ~0.80s (≈7x faster, 3-run avg).

**Keep `wxt prepare` first.** The typecheck depends on `.wxt/tsconfig.json` (the `extends` target) and `.wxt/wxt.d.ts` + `.wxt/types/*` (generated, git-ignored ambient types). A clean checkout/CI without `wxt prepare` would have a missing extends target and missing ambient types. The drop-in is therefore `wxt prepare && tsgo --noEmit`, **not** bare `tsgo --noEmit`.

**Caveats:**
- tsgo is a DEV PREVIEW (7.0.0-dev). Keep a `typecheck:tsc` fallback during the trial period to cross-check before trusting tsgo exclusively in CI gating.
- The installed `tsc` is **6.0.3** and tsgo targets "type checking matching TypeScript 6.0" — parity verified against TS6, not TS5. Re-verify if the repo pins a different tsc major.
- tsgo watch mode (`-w`) is supported but "rebuilds, no incremental rechecking, not optimized" per docs. Irrelevant to the one-shot `--noEmit` script.

---

## 2. oxlint — `.oxlintrc.json`

**Verdict on the original config claim: REFUTED as stated** — only because the `.oxlintrc.json` does not currently exist in the repo (nothing to evaluate). The *content* below is validated by differential category runs and the schema, and is what should be created.

Empirical facts:
- `bunx oxlint src` with **zero config** → exit 0, no findings. Default category is `correctness` only; the codebase is already clean at that level.
- The deliberate MAIN-world fetch/XHR monkey-patch (`src/entrypoints/inject.content.ts`) is **never flagged** by any rule under the correctness default — not even `no-global-assign`/`no-extend-native`.
- `no-control-regex` does **not** fire on the control-char regex literal at `src/core/download/filename.ts:4` even with `-D no-control-regex`. The `// eslint-disable-next-line no-control-regex` comment on line 3 is therefore superfluous (harmless; oxlint honors it).
- Enabling pedantic/style/all is pure noise here (~120 warnings: sort-keys, no-magic-numbers, no-ternary, id-length, unicorn escape-case/no-hex-escape on the `\x00-\x1f` bytes, etc.) plus real-but-unwanted errors on the two deliberate files. None indicate bugs. Keep pedantic/style/restriction/nursery **off**.

Preact / Effect specifics (verified parse behavior):
- `react/react-in-jsx-scope` produces 18 false positives in `App.tsx` under the automatic JSX runtime (`jsx: react-jsx`, `jsxImportSource: preact`). Fix: `"react/react-in-jsx-scope": "off"`.
- Do **NOT** add `react/jsx-uses-react` — it does not exist in oxlint and makes the whole config fail to parse ("Rule 'jsx-uses-react' not found").
- Do **NOT** set `settings.react.version: "detect"` — parse error ("invalid major version"). Leave version unset.
- Effect's `_tag` convention: allow-list via `no-underscore-dangle` `{ allow: ["_tag"] }`.
- Side-effect CSS import `import '../../app.css'`: allow-list via `import/no-unassigned-import` `{ allow: ["**/*.css"] }`.
- Setting `plugins` OVERWRITES oxlint's default set, so typescript/unicorn/oxc must be re-listed alongside import/promise/react/jsx-a11y.
- Overrides `files` must be globs: `"src/entrypoints/inject.content.ts"` silently does **not** match; `"**/inject.content.ts"` does. If that file moves, update the glob.

With the config below: correctness=error, suspicious=warn, perf=warn, everything else off. `inject.content.ts` and `filename.ts` are both fully clean. The only genuine findings that remain are 3× `jsx-a11y/control-has-associated-label` (App.tsx inputs lack programmatic label association) and 2× `vitest/no-conditional-expect` (schema.test.ts narrowing guard) — these are REAL and currently surface as errors; fix in code (add `aria-label`; restructure the test narrowing) or temporarily downgrade to warn before a green build.

CI: `oxlint --deny-warnings --format github` makes suspicious/perf warnings fail the build and emits GitHub Actions annotations. oxlint needs no tsconfig/type-info for these rules; runs in <100ms on this repo.

---

## 3. oxfmt — `.oxfmtrc.json` (MANDATORY)

**Verdict: a config is required and currently absent.** Without it, `oxfmt --check src` **fails** (exit 1, "No config found, using defaults") because oxfmt's defaults are **semi:true + singleQuote:false** — the OPPOSITE of this project's no-semicolon/single-quote style. Verified by stdin diff: defaults rewrite `from '../schema'` → `from "../schema";` across all ~23 files.

oxfmt 0.53.0 **does** honor the keys we need (verified): a config of `{ semi:false, singleQuote:true, tabWidth:2, trailingComma:"all" }` produces an **empty diff** on `filename.ts` (exact style match); a contradictory config produces double-quote+semicolon, proving the keys take effect. Defaults already match for printWidth(100), tabWidth(2), useTabs(false), trailingComma('all'), quoteProps('as-needed'), bracketSpacing(true), arrowParens('always'), endOfLine('lf') — strictly only `semi` and `singleQuote` must be overridden, but the artifact pins the full set for clarity.

With the correct config, ~5 src files still report diffs — these are **real line-wrap changes** at printWidth 100 (lines currently >100 cols), not a style mismatch. `oxfmt --write src` would rewrap them.

**oxfmt vs oxlint: no overlap, no conflict.** Verified: `oxlint src` produces zero formatting complaints (a `;;` + double-quote probe triggered only `no-unused-vars`). oxlint's `style` category is about idiomatic constructs, not whitespace/quotes/semicolons. Keep oxfmt the sole owner of formatting; never layer Prettier/ESLint-stylistic on top.

**Caveats:**
- oxfmt 0.53.0 is **BETA** (alpha Dec 2025, beta Feb 2026). 100% Prettier JS/TS conformance, used by vuejs/core, turborepo, sentry-javascript — but Prettier-plugin support and some embedded formatting are still on the roadmap; pre-1.0 output can shift between minors. Consider pinning the exact version (currently `^0.53.0`) so a beta bump doesn't silently reformat the tree.
- **Unknown config keys are silently ignored** in 0.53.0 (a `singleQuotes` typo did NOT error; fell back to defaults). Verify key spelling against `node_modules/oxfmt/configuration_schema.json` — typos fail open to the wrong style.
- `endOfLine: "auto"` is NOT supported (only lf/crlf/cr).
- `oxfmt --init` only emits `{ "ignorePatterns": [] }` — it does NOT scaffold the style, so the file must be authored explicitly.

---

## 4. Effect language-service — editor-only, CLI gate via the standalone tool

**Verdict: the blanket "does NOT change CLI typecheck results" is true ONLY for this project as configured; in general it is false** (the package ships a `patch` command that rewrites `node_modules/typescript` so `tsc` emits Effect diagnostics at build time). For THIS repo:

- `@effect/language-service` 0.86.2 is a **tsserver/LSP plugin** wired via `compilerOptions.plugins`. It adds Effect diagnostics, refactors, completions, quickinfo, codegens, goto, inlay hints — **only inside the editor**.
- It is **not currently wired** into any tsconfig here, and the installed TypeScript is verified "not patched" (`effect-language-service check`). So `tsc --noEmit` / `tsgo --noEmit` emit zero Effect diagnostics today.
- **Verified empirically**: even with `plugins: [{ name: "@effect/language-service", diagnosticSeverity: { tryCatchInEffectGen: "error" } }]` in a probe tsconfig, both `tsgo --noEmit` and `tsc --noEmit` exit 0 with no Effect output. Only tsserver reads `plugins`. README confirms: "if you run `tsc`, the plugin won't be loaded."
- The `patch` route (rewrites `typescript.js` + `_tsc.js`) **cannot help tsgo** (separate Go binary) and mutates `node_modules`. Since this repo's CI typecheck moves to tsgo, the patch route is a dead end here.

**Editor value** (optional, for the developer): add the `plugins` block to `tsconfig.json` (it is inert for CLI, harmless), and in VS Code run "TypeScript: Select TypeScript version → Use workspace version" (plugins load only with the workspace TS). Pin via `.vscode/settings.json`. Use `namespaceImportPackages: ["effect", "@effect/*"]` for v4's namespace-import style.

**CI gate for Effect rules** (the only tsgo-agnostic option): the standalone CLI.
```
bunx effect-language-service diagnostics --file src/core/download/strategy.ts --format pretty
bunx effect-language-service diagnostics --project tsconfig.json --format github-actions
```
Exit 1 on errors, 0 when clean. **Caveat:** `--project tsconfig.json` reported "Checked 0 files out of N" against this repo's WXT tsconfig (the `../**/*` include glob / program shape skips files). `--file <path>` (or a globbed loop) is the reliable fallback — validate `--project` mode before relying on it in CI.

**Effect-skill findings:** No Anthropic-official Effect skill/plugin exists (only open feature request Effect-TS/effect#5801). The installable option is the third-party `effect-mcp` docs MCP server (tim-smart/effect-mcp): `claude mcp add-json effect-docs '{"command":"npx","args":["-y","effect-mcp@latest"],"env":{}}' -s user`. context7 also indexes Effect as `/effect/effect`.

**Effect v4 idiom notes (from the src/core review, all stylistic — none are bugs):**
- Do **NOT** migrate `Context.Service` → `Effect.Service`: `Effect.Service` does **not exist** in effect v4. `Context.Service<Self, Shape>()("Id")` (what `settings/index.ts` already uses) is the canonical v4 service API. Keep as-is.
- `settings/index.ts`: replace throw-then-catch `Schema.decodeUnknownSync` with non-throwing `Schema.decodeUnknown` routed through the Effect channel + `Effect.orElseSucceed(defaults)`; materialize defaults via `SettingsSchema.make({})` instead of decoding `{}`; `set` currently decodes twice — one decode of the merged object suffices.
- `errors/index.ts`: `DetectError` is defined but **unused**; the resolver/adapter boundaries return `MediaItem[]` with zero Schema validation despite CONTEXT.md's "Capture untrusted until validated". Decode boundary output through `Schema.Array(MediaItem)` and surface `DetectError`. (Highest-value refinement.)
- `errors/index.ts` + `strategy.ts`: `DownloadError.reason: string` is built via `String(cause)`, discarding the original error — carry `readonly cause: unknown` instead.
- `download/queue.ts`: `Effect.forEach(..., { concurrency })` is correct v4. Retry uses `Schedule.recurs(retries)` with no backoff — compose `Schedule.exponential('200 millis')` + `Schedule.jittered` + `Schedule.compose(Schedule.recurs(retries))` for network resilience.

---

## 5. X media-combo audit — resolveTweetMedia + detectFromJson

**Verdict: CONFIRMED.** Run through the real exported functions via the project's vitest harness (10 combo tests + 5 edge tests, all passing; temp test files deleted afterward). Source: `src/core/resolver/index.ts` (`resolveTweetMedia` L40-74, `pickVideoVariant` L80-84, `upgradePhotoUrl` L90-98), `src/core/adapters/x/index.ts` (`detectFromJson` L34-50), `src/core/schema/index.ts` (`MediaItem` L5-17, `MediaType = ['photo','video','gif']`).

Behavior verified per combo: `count` = number of resolvable entries; `type` maps photo→`photo`, video→`video`, animated_gif→`gif`; `url` = photo upgraded to `name=orig`, video/gif = highest-bitrate `video/mp4` variant via `pickVideoVariant`; `index` = original media-array position (forEach index).

### Per-combo expected-output table

Assume `tweetId='T'`, `handle='h'`. `upgradePhotoUrl` forces `name=orig`; `pickVideoVariant` picks max-bitrate `video/mp4`; HLS (`application/x-mpegURL`) variants are ignored; `animated_gif` → type `gif` with ext from the `.mp4` variant url (NOT the `.jpg` thumbnail).

| Combo | len | Per-item expected (`type` / `ext` / `index` / `url` notes) |
|---|---|---|
| **1 photo** | 1 | `[0]` photo / jpg / 0 / `…/FglVYVmXkAIWB5w.jpg?name=orig` |
| **1 video** | 1 | `[0]` video / mp4 / 0 / max-bitrate (2176000) `…/1280x720/high.mp4`; HLS m3u8 ignored |
| **1 gif** | 1 | `[0]` gif / mp4 / 0 / `…/tweet_video/…​.mp4` (bitrate 0 still selected); url is the MP4 variant, NOT the `.jpg` thumbnail |
| **2 photos** | 2 | `[0]`,`[1]` photo / jpg|png (ext from url) / 0,1 / each `?name=orig` |
| **3 photos** | 3 | `[0..2]` photo / ext-from-url / 0,1,2 / each `?name=orig` |
| **4 photos** | 4 | `[0..3]` photo / ext-from-url (png preserved) / 0,1,2,3 / each `?name=orig` |
| **2 videos** | 2 | `[0]`,`[1]` video / mp4 / 0,1 / each its OWN per-video max-bitrate mp4 |
| **3 videos** | 3 | `[0..2]` video / mp4 / 0,1,2 / per-video max-bitrate mp4 |
| **4 videos** | 4 | `[0..3]` video / mp4 / 0,1,2,3 / per-video max-bitrate (e.g. 2176000, 1280000, 950000, 2176000) |
| **mixed 2pic+2video** (photo,video,photo,gif) | 4 | `[0]` photo/jpg/0/`?name=orig`; `[1]` video/mp4/1/max-bitrate mp4; `[2]` photo/png/2/`?name=orig`; `[3]` gif/mp4/3/`.mp4` variant. Flat GLOBAL index 0..3 across mixed types (NOT per-type), order preserved from `media[]` |

Confirmed-correct mechanics:
- `pickVideoVariant` (L80-84) filters `content_type === 'video/mp4'` then reduces to max `bitrate ?? 0` — correct per-video selection, mirrors TMH `parseBestVideoVariant`.
- Photo ext from `media_url_https` (preserves `.png`, falls back jpg); `upgradePhotoUrl` forces `name=orig` via `URLSearchParams`.
- `animated_gif` → ext from the variant url (`mp4`), NOT from the `.jpg` `media_url_https`. No "wrong ext for gif" bug.

### Known caveats (not bugs for clean combos)

- **B-index (non-contiguous indices after skips):** `index` is the original `media[]` position from `forEach`, assigned BEFORE skip decisions. An HLS-only video, or a video with no `video_info`, returns null (L59-60) and is dropped → surviving items keep their ORIGINAL indices, so the emitted sequence can have gaps (e.g. `[HLS-only-video, photo]` → one item with `index === 1`, no `index: 0`). Verified by test. For every combo above (all entries resolve) indices are contiguous 0..n-1. This affects the `{tweetId}_{index}.{ext}` filename token. **If contiguous output indices were ever required after skips, that is the only thing to change.**
- **B-drop (count < media length):** HLS-only / video-without-`video_info` entries yield ZERO MediaItems (matches TMH `isMp4` behavior). For mixed combos the output count can be < `media[].length`.
- **B-dedupe-key:** dedupe/id uses `m.id_str ?? basenameId(m.media_url_https)`; `media_key` is never used. If a (partial/DOM) capture omits `id_str`, a video's fallback id is derived from the `.jpg` THUMBNAIL basename, not the media. Harmless for dedupe but the MediaItem `id` for such a video is a thumbnail hash. Safer: prefer `media_key` (type prefix `3_`/`7_`/`16_` prevents cross-type collision) → `id_str` → basename.
- **B-cross-tweet-dedupe:** `detectFromJson` dedupes whole TWEETS by tweetId; `resolveTweetMedia` dedupes MEDIA per-tweet. There is no global media-level dedupe across tweets, so a quote/retweet wrapper embedding the same media id can duplicate it in the final flat array. Only manifests when the response contains both a tweet and its wrapper.
- **handle from quoted tweet:** `findScreenName` takes the FIRST `screen_name` under the tweet node; a quoted-tweet structure can pick the wrong author. Affects the `{handle}` filename token only, not media count/type/url.

### Tooling on the audited code
- `bunx oxlint src/core/resolver/index.ts src/core/adapters/x/index.ts` → exit 0, no findings.
- `bunx tsgo --noEmit -p tsconfig.json` → exit 0, no type errors.
- `bunx oxfmt --check` flags these files **only** because no config exists (default double-quote/semicolon noise) — not a code defect.

---

## Remaining risks

1. **oxfmt is beta (0.53.0)** — output may shift between minors; pin exact version. Unknown config keys fail open to defaults (verify spelling). `oxfmt --write` will rewrap ~5 files at the 100-col boundary on first run.
2. **tsgo is a dev preview** — keep a `typecheck:tsc` fallback to cross-check; only TS6 parity is verified.
3. **oxlint genuine findings** — 3× jsx-a11y `control-has-associated-label` (App.tsx) and 2× vitest `no-conditional-expect` (schema.test.ts) surface as errors and will fail a strict build until fixed in code or downgraded to warn.
4. **Effect rules are not enforced by CLI typecheck** — neither tsc nor tsgo emit them; the patch route can't reach tsgo. The `effect-language-service diagnostics` CLI is the only gate, and its `--project` mode currently skips files on this WXT tsconfig (use `--file`/globbed loop).
5. **Resolver index gaps after skips** (B-index) and **no cross-tweet media dedupe** (B-cross-tweet-dedupe) are latent: they only bite on HLS-only videos / quote-RT wrappers. Decide whether contiguous filename indices are a requirement before relying on `{tweetId}_{index}`.
6. **Config drift**: the oxlint override globs (`**/inject.content.ts`) break silently if the file is renamed/moved.
