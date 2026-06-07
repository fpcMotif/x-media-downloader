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

1. Wrap `chrome.runtime.sendMessage` / `onMessage` with schema encode on send and
   decode on receive; reject (no handler call) on `ParseError`.
2. `MessagingError extends Data.TaggedError`.

## Verification

- `bun test src/core/messaging` — all green.
