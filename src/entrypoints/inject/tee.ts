// Relocated to core/adapters/x/tracked-response.ts (the X PlatformAdapter's
// `isTrackedResponseUrl`, part of the multi-platform adapter abstraction —
// docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md). Re-export
// kept here so this entrypoint's existing import path (and inject.content.ts)
// don't need to change.
export { isGraphqlMediaUrl } from '../../core/adapters/x/tracked-response'
