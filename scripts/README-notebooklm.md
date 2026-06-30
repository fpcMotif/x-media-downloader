# Tweet Harvest → NotebookLM

`harvest_to_notebooklm.py` turns a **Tweet Harvest "Capture" JSONL export** into
threaded, per-conversation Markdown and (optionally) pushes it into a
[Google NotebookLM](https://notebooklm.google.com) notebook for further analysis
— ask questions across your captured threads, generate an audio overview, a
study guide, a mind map, etc.

The Markdown conversion is **standard-library Python 3 only** and needs nothing
installed. The NotebookLM push is optional and only runs when you pass
`--notebook`.

---

## 1. Get a JSONL export from the extension

1. Open the browser extension and enable **Capture** (it is OFF by default).
2. Browse X / open the threads you want; the extension harvests tweet text off
   the timeline/TweetDetail responses into local IndexedDB.
3. From the popup or the options page, choose **Export → all (JSONL)**.
   You get one file with one `ExportTweet` per line (the shape produced by
   `src/core/capture/export.ts`).

Save it somewhere, e.g. `~/Downloads/harvest.jsonl`.

---

## 2. (Optional) Install notebooklm-py for the push

The push step shells out to the `notebooklm` CLI — that CLI is the package's
documented public interface (see the notebooklm-py skill). Install it with `uv`
(preferred) or `pip`:

```bash
# uv (recommended — installs into an isolated tool environment)
uv tool install "notebooklm-py[browser]"

# or pip
pip install "notebooklm-py[browser]"
```

> The `[cookies]` extra (rookiepy) is known to fail to build on Python 3.13+.
> Skip it there and use interactive login instead.

Authenticate once (opens a browser for Google OAuth):

```bash
notebooklm login
notebooklm auth check --test --json   # expect "status": "ok" and checks.token_fetch: true
```

If you skip this, the conversion still works — the script just prints a clear
"NotebookLM push skipped" message and leaves you the Markdown files.

---

## 3. Run the script

```bash
# Convert only — write per-conversation Markdown to ./harvest-md
python3 scripts/harvest_to_notebooklm.py ~/Downloads/harvest.jsonl

# Custom output directory
python3 scripts/harvest_to_notebooklm.py ~/Downloads/harvest.jsonl --out ./threads

# Preview without writing anything (prints the grouping + Markdown)
python3 scripts/harvest_to_notebooklm.py ~/Downloads/harvest.jsonl --dry-run

# Convert AND push to a new NotebookLM notebook
python3 scripts/harvest_to_notebooklm.py ~/Downloads/harvest.jsonl \
    --notebook "Tweet Harvest 2026-06"

# Push and also request an audio overview of the threads
python3 scripts/harvest_to_notebooklm.py ~/Downloads/harvest.jsonl \
    --notebook "Tweet Harvest 2026-06" --audio
```

### Flags

| Flag             | Default        | Meaning |
|------------------|----------------|---------|
| `input`          | (required)     | Path to the exported Tweet Harvest JSONL. |
| `--out DIR`      | `./harvest-md` | Directory for the per-conversation Markdown. |
| `--notebook NAME`| _(off)_        | Create a NotebookLM notebook with this name and add each `.md` as a source. Skipped with a message if the `notebooklm` CLI is absent. |
| `--audio`        | _(off)_        | With `--notebook`, also request an audio overview (fire-and-forget). |
| `--dry-run`      | _(off)_        | Print grouping + a Markdown preview; write nothing and never touch NotebookLM. |

---

## What it produces

- **Grouping:** tweets are grouped by `conversationId`. Within each
  conversation the reply tree is reconstructed from `replyTo.id`; a tweet whose
  parent was not captured becomes a root (never dropped). Roots and replies are
  ordered chronologically by `createdAt`.

- **One Markdown file per conversation**, named `<handle>-<conversationId>.md`,
  written to `--out`. The layout mirrors the extension's own `toMarkdown`
  renderer:

  ```markdown
  # Thread by @alice

  - **@alice** (Alice) · 2026-06-01T10:00:00.000Z · [link](https://x.com/alice/status/1)
    Hello world
    - 🔗 Some Article — https://example.com/post
    - 🎞 2 photo
    > quote https://x.com/bob/status/9: nice point
    - **@bob** (Bob) · 2026-06-01T10:05:00.000Z · [link](https://x.com/bob/status/2)
      I agree
  ```

  - Each tweet: `**@handle** (Name) · ISO-time · [link](permalink)`.
  - Tweet text is indented under the byline; replies are nested one level deeper.
  - `- 🔗 title — url` per external link.
  - `- 🎞 N type` per media type (one line per type, with a count).
  - `> quote <url>: <text>` for a quoted tweet (`(not captured)` when the quote
    body was not harvested).

- **With `--notebook`:** a notebook is created and every `.md` is uploaded as a
  source. A failed upload is reported but never aborts the run or discards the
  Markdown you already have on disk.

---

## How it fits together

```
Extension Capture  →  Export all (JSONL)  →  harvest_to_notebooklm.py  →  ./harvest-md/*.md
                                                                       └→ (optional) NotebookLM notebook
```

Once the sources are in NotebookLM you can use the CLI (or web UI) to analyse
them, e.g.:

```bash
notebooklm ask "What are the recurring themes across these threads?"
notebooklm generate report --format briefing-doc
notebooklm generate mind-map
```
