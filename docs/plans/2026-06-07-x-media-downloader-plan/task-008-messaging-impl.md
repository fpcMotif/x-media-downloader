# Task 008 — Messaging (impl)

**type:** impl
**depends-on:** ["008-messaging-test"]

## Contract

```ts
export const send: <M extends Message>(msg: M) => Effect.Effect<Message, MessagingError>
export const onMessage: (handler: (msg: Message) => Effect.Effect<Message>) => void
```

## Files

- `src/core/messaging/index.ts`

## Steps

1. Wrap `browser.runtime.sendMessage` / `onMessage` with schema encode on send and
   decode on receive; reject (no handler call) on `SchemaError`. The `onMessage`
   listener returns literal `true` and calls `sendResponse` from the
   `Effect.runPromise` callback (never a bare `async` listener). SW→content uses
   `browser.tabs.sendMessage(tabId, …)`.
2. `MessagingError extends Data.TaggedError`. Distinguish the retryable
   no-receiver error ("Could not establish connection…") from non-retryable
   `SchemaError`. Stream `QueueUpdate` over a named
   `runtime.connect({ name: 'queue' })` port.

## Verification

- `bun test src/core/messaging` — all green.
