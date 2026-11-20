---
name: named-ui-state
subject: useState declarations in Preact components and hooks.
requirement: >
  Component state that has phases declares them as a tagged union or a
  string-literal union. A loading, idle, empty, or failed phase is a named
  member, never null, undefined, or a boolean paired with a nullable value.
purpose: Stop one null from standing for loading, failure, and empty at once.
applicability: Files under src/entrypoints/popup, src/entrypoints/options, and src/components.
guidance: >
  Use Loaded<T> from src/components/use-loaded.ts for anything fetched.
---

## Violates

    const [summary, setSummary] = useState<CaptureSummary | null>(null)

## Satisfies

    const summaryLoad = useLoaded(loadArchiveSummary)
