# Setup — type-aware oxlint, oxfmt, and the JSDoc policy

The toolchain that enforces [`SKILL.md`](SKILL.md). oxc replaces ESLint and
Prettier; `tsc` stays as the type gate.

Each step carries the failures that actually bite it. They are things no config
file confesses, so read the step before running it.

## 1. Install, pinned

```bash
bun add -d -E oxlint oxlint-tsgolint oxfmt eslint-plugin-jsdoc lefthook typescript
```

`-E` (exact) because the JS-plugin loader carrying `eslint-plugin-jsdoc` is
alpha and outside semver.

**`oxlint-tsgolint` is what makes `--type-aware` real.** Without it the flag
prints `Failed to find tsgolint executable` and exits **0** — a green run that
checked nothing.

**Call the local binary, not `bunx`.** `bunx oxlint` can resolve a different
install and silently skip the type-aware pass, reporting clean while real
`no-floating-promises` errors sit in the tree:

```bash
./node_modules/.bin/oxlint --type-aware .
```

Package scripts resolve `node_modules/.bin` themselves, so `bun run lint` is
safe; ad-hoc terminal calls are the ones that lie.

## 2. tsconfig: the strict base

Both `tsc` and tsgolint read this file. Turn on `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
and `verbatimModuleSyntax`.

**Delete `baseUrl`.** tsgolint is TS7-based and rejects it outright:
`Invalid tsconfig — Option 'baseUrl' has been removed`. This fires once per
file and takes the whole type-aware pass down with it. `paths` resolve relative
to the tsconfig without it.

**Weigh `exactOptionalPropertyTypes` against your component library.** Wrappers
over Radix/Base-UI-style prop types fail it structurally on every
`className`/`style` spread with no bug behind it. Turn it on where the props are
yours; leave it off and say so in a comment where they are not.

## 3. oxfmt

```jsonc
// .oxfmtrc.json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 100,
  "sortImports": { "groups": [/* … */] }
}
```

`sortImports` is off by default — enable it, then never hand-sort. Import order
stops being a review topic.

oxfmt reads `.gitignore`. **Add build output, bundle reports, and any scraped or
vendored reference to `.gitignore` before the first run**, or `fmt:check`
fails on generated files forever.

Format the whole repo once to set the baseline, so later diffs are content.

## 4. oxlint config

Use `oxlint.config.ts` for comments and type-checked rule names.

**Setting `plugins` REPLACES the default set** — list `"eslint"` explicitly or
you silently lose every core rule. Add `"react"` and `"jsx-a11y"` for a React
app.

Enable type-aware rules through `options: { typeAware: true }`. Leave
`typeCheck` off: it is experimental, and `tsc --noEmit` is the gate.

Load `eslint-plugin-jsdoc` through `jsPlugins` under an alias — `"jsdoc"` is
reserved by the native Rust plugin:

```ts
jsPlugins: [{ name: "jsdoc-js", specifier: "eslint-plugin-jsdoc" }],
```

**The native `jsdoc/check-tag-names` knows JSDoc's tag list, not TSDoc's**, so
it errors on `@defaultValue` and `@remarks`. Admit them, and use `typed` to ban
the tags that duplicate TypeScript:

```ts
"jsdoc/check-tag-names": ["error", { definedTags: ["defaultValue", "remarks"], typed: true }],
```

Pick rules that fit the framework. A rule that fights the framework's own
contract is worse than no rule — `react/no-multi-comp` breaks a router's
`App` + `ErrorBoundary` file, `import/no-duplicates` breaks the `import type` +
`import` split that `verbatimModuleSyntax` forces, and
`typescript/promise-function-async` breaks a streaming `entry.server`. Probe
each candidate against the real tree, and record why a rejected rule was
rejected.

Severity follows hit count: near-zero false positives and zero current hits →
`error`; a heuristic, or anything that lights up existing files → `warn`.

## 5. The require-jsdoc policy

`SKILL.md` decides which symbols carry a contract. Encode that split by
directory in `overrides` so the linter asks only where the answer is yes. This
is policy-as-config: the next file added to a directory inherits the decision,
and no symbol needs a suppression comment.

Three override semantics, each verified on oxlint 1.80 and each silent when
wrong:

- **Last matching block wins.** A blanket `off` over a directory followed by a
  narrower `warn` on one path re-enables it. Reverse the order and it stays off.
- **An override's rule value REPLACES the base config; it does not merge.** A
  bare `"warn"` reverts the rule to the plugin's own defaults — dropping
  `publicOnly`, `ArrowFunctionExpression`, and `contexts`, which both
  under-fires and over-fires. Hoist the options object to module scope and pass
  it in **every** block that re-enables the rule.
- **`files` globs resolve relative to the config file's directory.** With the
  config at the repo root, `app/components/ui/**` is right. A config elsewhere
  matches nothing and reports clean.

**`require-jsdoc` cannot see through `React.forwardRef(...)`** — the arrow
function sits inside a `CallExpression`, so the component is invisible and the
rule lands on the `*Props` interface instead. Expect it; document it in the
config rather than fighting it.

Re-check the policy whenever a refactor moves behavior: an exception justified
by a side effect is stale the moment that side effect moves to another file.

## 6. Scripts

```jsonc
{
  "fmt": "oxfmt",
  "fmt:check": "oxfmt --check",
  "lint": "oxlint --type-aware",
  "lint:fix": "oxlint --type-aware --fix",
  "lint:ci": "oxlint --type-aware --deny-warnings",
  "typecheck": "tsc --noEmit",
  "check": "bun run fmt:check && bun run lint && bun run typecheck"
}
```

`lint:ci` is the destination once the tree is clean. Until then run
`--deny-warnings` only over files changed against the main branch, so existing
warnings never block a merge and new ones cannot land.

**`bun test` exits non-zero with zero test files.** Add `test` to `check` when
the first real test lands — a placeholder test to make the gate green makes the
gate lie.

## 7. Pre-commit

Keep the hook mechanical: `oxfmt` plus `oxlint --fix` over staged files, with
the JSDoc rules allowed through via `-A`. Contract-writing is judgment, and
judgment belongs in review, not in a hook. Skip `--type-aware` here — it needs a
whole-program build and is too slow to sit in front of a commit.

`lefthook install` needs a git repo. If `prepare` runs it, let it fall through
with a message so `bun install` still succeeds before `git init`.

## 8. Verify

Run each yourself and read the output — a passing report from a subagent is a
claim, not a result:

```bash
bun run check
```

Then confirm the policy points the right way: a directory you exempted emits no
`require-jsdoc`, and one you require still does. If that is inverted, the
override order is wrong.

## Done

- `bun run check` exits 0.
- `--type-aware` is genuinely running: `oxlint-tsgolint` is installed, and
  removing a rule's fix reproduces a type-aware diagnostic.
- Every rule you rejected has a recorded reason.
- The build still succeeds.
