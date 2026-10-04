# CLAUDE.md — project notes

See [AGENTS.md](./AGENTS.md) for the engineering standards, checks, and JSDoc contract.

## Tooling

- Shell-first for file edits and scripting: `sed`, heredocs, or a `bun` script. Do not reach for
  Python unless the task genuinely needs it (e.g. a library only Python has).
- When Python is needed, run it through `uv` / `uvx` (`uv run script.py`, `uvx <tool>`), never a bare
  `python3`.
- Package manager is **bun** (`bun`, `bunx`) — never npm/npx.
