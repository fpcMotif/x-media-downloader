---
name: effect-needs-external-system
subject: useEffect calls in Preact components and hooks.
requirement: >
  An effect exists only to synchronize with a system outside the component: a
  timer, a DOM or window listener, a browser extension API, a network or
  message call, or imperative focus. An effect whose body only reads props or
  state and calls a state setter must be replaced by a value derived during
  render, a key that remounts the child, or code in the event handler that
  caused the change.
purpose: Remove extra renders and stale frames caused by state-syncing effects.
applicability: Files under src/entrypoints/popup, src/entrypoints/options, and src/components.
guidance: >
  Mount-time data loads go through useLoaded from src/components/use-loaded.ts.
  Host-permission checks go through useOriginGrant from
  src/components/use-origin-grant.ts. An effect that subscribes must return a
  cleanup.
---

## Violates

    useEffect(() => {
      setDraft(clientId)
    }, [clientId])

## Satisfies

    <CloudProviderRow key={clientId} clientId={clientId} />

    useEffect(() => {
      const id = setInterval(tick, TICK_MS)
      return () => clearInterval(id)
    }, [tick])
