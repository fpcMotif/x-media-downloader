const PAGE_ONLY_TRACE_STAGES: ReadonlySet<string> = new Set(['shown', 'nudged', 'armed'])

export const isPageOnlyTraceStage = (stage: string): boolean => PAGE_ONLY_TRACE_STAGES.has(stage)
