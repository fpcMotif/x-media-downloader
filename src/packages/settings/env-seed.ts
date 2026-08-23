import type { Settings } from '@/packages/schema'

/** Decide the dev-convenience Convex pre-seed (ADR-0009, ADR-0022). Returns the settings patch,
 *  or null when seeding must not happen. NEVER returns a patch touching a non-empty
 *  field. Pure given `genId` (prod: crypto.randomUUID; test: a counter). The caller owns
 *  the import.meta.env.DEV guard and the env reads (validated via Varlock schema) — the secret literal must stay at the
 *  DEV-gated edge so Vite tree-shakes it out of production builds. */
export function planConvexEnvSeed(
  settings: Pick<Settings, 'convexUrl' | 'convexSyncSecret' | 'cloudDeviceId'>,
  env: { readonly url?: string | undefined; readonly secret?: string | undefined },
  genId: () => string,
): Partial<Settings> | null {
  if (!env.url || !env.secret || settings.convexUrl !== '' || settings.convexSyncSecret !== '')
    return null
  return {
    convexUrl: env.url,
    convexSyncSecret: env.secret,
    cloudSyncEnabled: true,
    ...(settings.cloudDeviceId === '' ? { cloudDeviceId: genId() } : {}),
  }
}

/** Decide the cloud OAuth client-id pre-seed (ADR-0013): each id independently gated on
 *  its field being empty; both fold into ONE patch. Null when nothing to seed. */
export function planCloudEnvSeed(
  settings: Pick<Settings, 'gdriveClientId' | 'dropboxClientId'>,
  env: {
    readonly gdriveClientId?: string | undefined
    readonly dropboxAppKey?: string | undefined
  },
): Partial<Settings> | null {
  const patch: Partial<Settings> = {
    ...(env.gdriveClientId && settings.gdriveClientId === ''
      ? { gdriveClientId: env.gdriveClientId }
      : {}),
    ...(env.dropboxAppKey && settings.dropboxClientId === ''
      ? { dropboxClientId: env.dropboxAppKey }
      : {}),
  }
  return Object.keys(patch).length > 0 ? patch : null
}
