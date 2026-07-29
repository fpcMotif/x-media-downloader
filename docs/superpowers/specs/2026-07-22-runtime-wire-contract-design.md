# Runtime Wire Contract Design

Status: accepted

## Vocabulary

- **Background Request**: one JSON message sent to the extension worker with
  `runtime.sendMessage`.
- **Tab Request**: one request sent to one content script with
  `tabs.sendMessage`.
- **Tab Broadcast**: a fire-and-forget worker notification sent to matching
  content-script tabs.
- **Reply**: the response paired with one request. It is never valid worker
  input.
- **Offscreen Protocol**: the separate worker-to-offscreen Blob protocol. It
  keeps its own decoder and sender guard.

Chrome serializes extension messages as JSON and limits one message to 64 MiB.
That platform ceiling is not an application budget. Large messages can still
stall or kill an ephemeral MV3 worker. See
<https://developer.chrome.com/docs/extensions/develop/concepts/messaging>.

## Problem

The old `Message` union mixed background requests, replies, and tab broadcasts.
The worker could decode reply-only tags as input. `TabBroadcaster` could accept
request-shaped data. Several page-derived arrays and strings had no resource
limit. The schema barrel also imported the Capture parser and its adapter graph
at runtime.

## Contract Shape

Export three narrow unions:

```text
BackgroundRequest  content/UI -> worker
TabRequest         popup/worker -> one content script
TabBroadcast       worker -> content-script tabs
```

Each request keeps its own reply decoder. There is no global reply union.
`decodeBackgroundRequest` is the only background ingress decoder. The sender
guard accepts only `BackgroundRequest['_tag']`. The broadcaster accepts only
`TabBroadcast`.

Schemas remain exact. Unknown keys fail. Direction is part of the type, not a
comment.

## Resource Policy

Large request tags get a tag-specific JSON byte budget before Effect schema
decode. A fail-closed walker counts canonical UTF-8 JSON bytes and stops at the
budget. It accepts only plain records, arrays, strings, finite numbers,
booleans, and null. It does not call `JSON.stringify`, invoke `toJSON`, or build
another whole payload.

Counts and field limits remain domain rules:

- Offscreen Blob: exact worker-only messages. Lease IDs are at most 512 code
  units; MIME types 128; errors 256; chunks 256 KiB. One lease holds at most
  15 MiB. The document retains at most four leases and 60 MiB total until
  terminal disposal. A fifth valid handoff waits outside the Blob lifecycle
  lane without opening its response source. Once disposal frees a durable slot,
  the lifecycle lane opens, validates, and streams it. This bounds retained
  Blob URLs and pending response bodies without reducing the 15 MiB Fetched
  media/export limit or rejecting valid batches.

- Download: at most 64 Media Items per request. A post is never split between
  chunks. Each Media Item also fits the Transfer Registry's durable field and
  byte limits.
- `clearExpect`: unique bounded post IDs and media IDs. Each post must appear in
  the request. Its IDs may include unstarted prerequisites; this is required by
  For You whole-post Clear safety.
- Sweep: X-only, at most 16 posts and four items per post. Large mounted sets
  are chunked by the producer and replies are summed.
- Saved Status: at most 100 unique X post IDs per request, reply, or broadcast.
  A reply must be a subset of its request. The producer chunks larger sweeps.
- Capture: at most 64 records, 256 KiB per record, and 2 MiB per message. The
  FIFO packs by count and bytes. One oversize record is dropped with explicit
  telemetry; it cannot poison retries for later records.
- Settings: UI patches contain only UI-owned fields. Provider tokens, expiry,
  account, folder, persisted client ID, and device ID are worker-owned. One
  patch is at most 32 KiB. The exact success reply is a complete Settings
  snapshot; failure detail is bounded. Persisted string fields have
  field-specific bounds, including larger bounds for OAuth tokens.
- Recovery: exact 1–20 digit snowflake input; one fixed-host streamed UTF-8
  response is at most 64 KiB. `Content-Length` is only an early rejection; the
  reader enforces the same cap and cancels on overflow or caller cancellation.
  Failure has one stable tag-only reply, so the overlay cannot parse an unbounded
  body.
- Trace, OAuth client, export, URL, ID, and reply arrays keep narrow field or
  count bounds.

X documents at most four media attachments on one Post. This supports the
Sweep rule, which only runs on X list pages:
<https://docs.x.com/x-api/media/quickstart/best-practices>.

## Producer Rules

A cap without producer handling is data loss. Producers partition before send,
preserve order, and aggregate replies. Download partitioning groups by post so
Clear sees the full post before any transfer starts. Capture packing preserves
FIFO order. An individual value that cannot fit returns an explicit local
failure or telemetry event; it is never retried forever.

## Dependency Direction

```text
wire/{exact,json-budget,limits}
        ^
schema domain modules <- capture/record-schema
        ^
schema/index (re-export only)
        ^
parsers, clients, worker, UI
```

`capture/record-schema` is Effect-only. Capture parsing imports and re-exports
that contract. Shared wire limits do not live in Transfer Registry internals.

## Proof

- Every background request reaches only its intended handler.
- Replies and broadcasts fail background ingress decode.
- Tab requests and broadcasts pass only their intended content path.
- Sender-guard exhaustiveness uses `BackgroundRequest['_tag']`.
- Oversize, duplicate, cross-post, and response-not-subset cases fail closed.
- Chunking preserves order, every item, whole-post grouping, and aggregate
  counts.
- Capture parser code is absent from the shared schema dependency graph.
- Full format, lint, type, Effect, test, build, and live MV3 gates pass.
