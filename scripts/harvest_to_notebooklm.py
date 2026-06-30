#!/usr/bin/env python3
"""Turn an exported Tweet Harvest JSONL into NotebookLM-ready Markdown.

The Tweet Harvest "Capture" feature in the browser extension exports one
``ExportTweet`` per line (see ``src/core/capture/export.ts``). This script reads
that JSONL, groups tweets by ``conversationId``, reconstructs each reply tree
from ``replyTo.id``, and renders threaded Markdown that mirrors the extension's
``toMarkdown`` renderer -- one ``.md`` per conversation, ready to drop into a
NotebookLM notebook as a source.

Conversion is standard-library only. The optional NotebookLM push shells out to
the ``notebooklm`` CLI (the package's documented public interface; see the
notebooklm-py skill). If that CLI is not installed the push is skipped with a
clear message and the conversion still succeeds.

Usage:
    python3 harvest_to_notebooklm.py harvest.jsonl
    python3 harvest_to_notebooklm.py harvest.jsonl --out ./harvest-md
    python3 harvest_to_notebooklm.py harvest.jsonl --notebook "Tweet Harvest"
    python3 harvest_to_notebooklm.py harvest.jsonl --notebook "Tweet Harvest" --audio
    python3 harvest_to_notebooklm.py harvest.jsonl --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# Reading                                                                      #
# --------------------------------------------------------------------------- #


def read_jsonl(path: Path) -> List[Dict[str, Any]]:
    """Parse a JSONL file into a list of tweet dicts, skipping blank lines.

    Malformed lines are reported to stderr and skipped rather than aborting the
    whole run -- a single bad line should not lose an entire harvest.
    """
    tweets: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"warning: skipping malformed JSON on line {lineno}: {exc}", file=sys.stderr)
                continue
            if isinstance(obj, dict) and "id" in obj:
                tweets.append(obj)
            else:
                print(f"warning: skipping line {lineno}: not an ExportTweet object", file=sys.stderr)
    return tweets


# --------------------------------------------------------------------------- #
# Grouping + tree reconstruction                                              #
# --------------------------------------------------------------------------- #


def group_by_conversation(tweets: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Group tweets by ``conversationId`` (falling back to the tweet ``id``).

    Insertion order of conversations is preserved (first-seen wins) so output
    file ordering is stable across runs of the same input.
    """
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for t in tweets:
        conv = t.get("conversationId") or t.get("id") or "unknown"
        groups.setdefault(conv, []).append(t)
    return groups


def _reply_parent_id(tweet: Dict[str, Any]) -> Optional[str]:
    reply_to = tweet.get("replyTo")
    if isinstance(reply_to, dict):
        return reply_to.get("id")
    return None


def build_forest(tweets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Reconstruct the reply forest for one conversation.

    Each returned node is a shallow copy of the source tweet with an added
    ``children`` list. A tweet is a root when its ``replyTo.id`` is absent or
    points outside this conversation (so we never silently drop a tweet whose
    parent was not captured). Roots and children are ordered by ``createdAt``
    then ``id`` for deterministic, chronological output.
    """
    nodes: Dict[str, Dict[str, Any]] = {}
    for t in tweets:
        tid = t.get("id")
        if tid is None:
            continue
        node = dict(t)
        node["children"] = []
        nodes[tid] = node

    roots: List[Dict[str, Any]] = []
    for tid, node in nodes.items():
        parent_id = _reply_parent_id(node)
        if parent_id is not None and parent_id in nodes and parent_id != tid:
            nodes[parent_id]["children"].append(node)
        else:
            roots.append(node)

    def sort_key(n: Dict[str, Any]) -> Tuple[str, str]:
        return (n.get("createdAt") or "", str(n.get("id") or ""))

    def sort_recursive(level: List[Dict[str, Any]]) -> None:
        level.sort(key=sort_key)
        for n in level:
            sort_recursive(n["children"])

    sort_recursive(roots)
    return roots


# --------------------------------------------------------------------------- #
# Markdown rendering (mirrors src/core/capture/export.ts toMarkdown)          #
# --------------------------------------------------------------------------- #


def _media_counts(media: Iterable[Dict[str, Any]]) -> List[Tuple[str, int]]:
    """Ordered ``(type, count)`` pairs so one media line is emitted per type."""
    counts: Dict[str, int] = {}
    order: List[str] = []
    for m in media:
        mtype = str(m.get("type", "media"))
        if mtype not in counts:
            order.append(mtype)
        counts[mtype] = counts.get(mtype, 0) + 1
    return [(t, counts[t]) for t in order]


def _render_node(node: Dict[str, Any], depth: int, out: List[str]) -> None:
    pad = "  " * depth
    author = node.get("author") or {}
    handle = author.get("handle") or "unknown"
    name = author.get("name")
    name_suffix = f" ({name})" if name else ""
    when = node.get("createdAt") or "unknown time"
    url = node.get("url") or ""

    out.append(f"{pad}- **@{handle}**{name_suffix} · {when} · [link]({url})")

    text = node.get("text") or ""
    for line in text.split("\n"):
        out.append(f"{pad}  {line}")

    for link in node.get("links") or []:
        title = link.get("title")
        title_prefix = f"{title} — " if title else ""
        out.append(f"{pad}  - 🔗 {title_prefix}{link.get('url', '')}")

    for mtype, count in _media_counts(node.get("media") or []):
        out.append(f"{pad}  - 🎞 {count} {mtype}")

    quote = node.get("quote")
    if isinstance(quote, dict):
        qtext = quote.get("text")
        out.append(f"{pad}  > quote {quote.get('url', '')}: {qtext if qtext else '(not captured)'}")

    for child in node.get("children") or []:
        _render_node(child, depth + 1, out)


def render_markdown(roots: List[Dict[str, Any]]) -> str:
    """Threaded, depth-indented Markdown for one conversation."""
    root_handle = None
    if roots:
        author = roots[0].get("author") or {}
        root_handle = author.get("handle")
    header = f"# Thread by @{root_handle}" if root_handle else "# Thread"
    out: List[str] = [header, ""]
    for root in roots:
        _render_node(root, 0, out)
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# Filenames                                                                    #
# --------------------------------------------------------------------------- #

_SLUG_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def conversation_filename(conv_id: str, roots: List[Dict[str, Any]]) -> str:
    """A stable, filesystem-safe ``.md`` filename for a conversation.

    Form: ``<handle>-<conversationId>.md`` so files sort by author and never
    collide (the conversation id keeps them unique even for the same author).
    """
    handle = None
    if roots:
        author = roots[0].get("author") or {}
        handle = author.get("handle")
    slug_handle = _SLUG_RE.sub("-", handle).strip("-") if handle else "thread"
    slug_conv = _SLUG_RE.sub("-", str(conv_id)).strip("-") or "unknown"
    return f"{slug_handle}-{slug_conv}.md"


# --------------------------------------------------------------------------- #
# NotebookLM push (optional; shells out to the `notebooklm` CLI)              #
# --------------------------------------------------------------------------- #


class NotebookLMUnavailable(Exception):
    """Raised when the notebooklm CLI is not installed / not on PATH."""


def _notebooklm_bin() -> str:
    """Locate the ``notebooklm`` CLI, or raise NotebookLMUnavailable.

    The notebooklm-py package's documented public interface is its CLI (see the
    notebooklm-py skill), so we detect that rather than importing a module --
    the package is typically installed into an isolated uv/pipx environment that
    the running interpreter cannot import.
    """
    found = shutil.which("notebooklm")
    if found is None:
        raise NotebookLMUnavailable(
            "The `notebooklm` CLI was not found on PATH. Install it with:\n"
            '  uv tool install "notebooklm-py[browser]"   (or)   '
            'pip install "notebooklm-py[browser]"\n'
            "then authenticate once with `notebooklm login`. "
            "See scripts/README-notebooklm.md."
        )
    return found


def _run_notebooklm(args: List[str]) -> str:
    proc = subprocess.run(
        args,
        check=True,
        capture_output=True,
        text=True,
    )
    return proc.stdout


def create_notebook(name: str) -> str:
    """Create a notebook via the CLI and return its id."""
    nb = _notebooklm_bin()
    out = _run_notebooklm([nb, "create", name, "--json"])
    data = json.loads(out)
    return data["notebook"]["id"]


def add_source(notebook_id: str, md_path: Path) -> str:
    """Add one Markdown file as a notebook source and return its id."""
    nb = _notebooklm_bin()
    out = _run_notebooklm(
        [nb, "source", "add", str(md_path), "--notebook", notebook_id, "--json"]
    )
    data = json.loads(out)
    return data["source"]["id"]


def generate_overview(notebook_id: str) -> None:
    """Kick off an audio overview generation (fire-and-forget)."""
    nb = _notebooklm_bin()
    _run_notebooklm(
        [
            nb,
            "generate",
            "audio",
            "Give an overview of these captured tweet threads and the themes across them.",
            "--notebook",
            notebook_id,
        ]
    )


def push_to_notebooklm(name: str, md_files: List[Path], *, audio: bool) -> None:
    """Create the notebook and add every Markdown file as a source.

    Never raises out to the caller for an operational failure -- a failed push
    must not undo a successful conversion. Only argument/environment problems
    surface as a clear message.
    """
    try:
        _notebooklm_bin()
    except NotebookLMUnavailable as exc:
        print(f"\nNotebookLM push skipped: {exc}", file=sys.stderr)
        return

    try:
        print(f"\nCreating NotebookLM notebook: {name!r} ...")
        notebook_id = create_notebook(name)
        print(f"  notebook id: {notebook_id}")
    except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError) as exc:
        _report_push_failure("create notebook", exc)
        return

    added = 0
    for md in md_files:
        try:
            source_id = add_source(notebook_id, md)
            added += 1
            print(f"  + added source {md.name} ({source_id})")
        except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError) as exc:
            _report_push_failure(f"add source {md.name}", exc)
            # continue with the rest -- one bad source should not abort the push

    print(f"  added {added}/{len(md_files)} sources to notebook {notebook_id}")

    if audio:
        try:
            print("  starting audio overview generation (fire-and-forget) ...")
            generate_overview(notebook_id)
            print("  audio overview requested; check `notebooklm artifact list` later.")
        except subprocess.CalledProcessError as exc:
            _report_push_failure("generate audio overview", exc)


def _report_push_failure(step: str, exc: Exception) -> None:
    detail = ""
    if isinstance(exc, subprocess.CalledProcessError):
        detail = (exc.stderr or exc.stdout or "").strip()
        if detail:
            detail = f"\n    {detail.splitlines()[-1]}"
        if exc.returncode == 1 and "auth" in (exc.stderr or "").lower():
            detail += "\n    (try `notebooklm login` to re-authenticate)"
    print(f"  NotebookLM push: failed to {step}: {exc}{detail}", file=sys.stderr)


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert a Tweet Harvest JSONL export into per-conversation "
        "threaded Markdown and (optionally) push it to a NotebookLM notebook.",
    )
    parser.add_argument("input", type=Path, help="Path to the exported Tweet Harvest JSONL file.")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("./harvest-md"),
        help="Directory for the per-conversation Markdown (default: ./harvest-md).",
    )
    parser.add_argument(
        "--notebook",
        metavar="NAME",
        help="If given, create a NotebookLM notebook with this name and add each "
        ".md as a source (requires the `notebooklm` CLI; otherwise skipped).",
    )
    parser.add_argument(
        "--audio",
        action="store_true",
        help="With --notebook, also request an audio overview of the threads.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be written (and a Markdown preview) without "
        "writing files or touching NotebookLM.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if not args.input.exists():
        print(f"error: input file not found: {args.input}", file=sys.stderr)
        return 1

    tweets = read_jsonl(args.input)
    if not tweets:
        print("error: no tweets found in input.", file=sys.stderr)
        return 1

    groups = group_by_conversation(tweets)
    print(
        f"Read {len(tweets)} tweet(s) across {len(groups)} conversation(s) "
        f"from {args.input}"
    )

    rendered: List[Tuple[str, str, str]] = []  # (filename, conv_id, markdown)
    for conv_id, conv_tweets in groups.items():
        roots = build_forest(conv_tweets)
        markdown = render_markdown(roots)
        filename = conversation_filename(conv_id, roots)
        rendered.append((filename, conv_id, markdown))

    if args.dry_run:
        print("\n--- DRY RUN (no files written) ---")
        for filename, conv_id, markdown in rendered:
            count = len(groups[conv_id])
            print(f"\n[{filename}]  conversation={conv_id}  tweets={count}")
            print(markdown)
        if args.notebook:
            print(
                f"\nWould create NotebookLM notebook {args.notebook!r} and add "
                f"{len(rendered)} source(s)."
            )
            if args.audio:
                print("Would also request an audio overview.")
        return 0

    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    written: List[Path] = []
    for filename, _conv_id, markdown in rendered:
        dest = out_dir / filename
        dest.write_text(markdown + "\n", encoding="utf-8")
        written.append(dest)
    print(f"\nWrote {len(written)} Markdown file(s) to {out_dir}")

    if args.notebook:
        push_to_notebooklm(args.notebook, written, audio=args.audio)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
