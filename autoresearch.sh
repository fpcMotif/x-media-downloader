#!/usr/bin/env bash
# Autoresearch benchmark entrypoint — Release flow (X Bookmarks/Likes → /i/history).
#
# Deterministic: fixture DOM + virtual clock; no network, no wall-clock timing,
# no live X dependency. Prints one `METRIC <name>=<value>` line per metric on
# stdout; exit 0 iff every scenario reached a verdict.
set -euo pipefail
cd "$(dirname "$0")"
exec bun bench/release-bench.ts
