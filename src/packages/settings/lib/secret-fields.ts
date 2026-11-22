import { isJsonObject, type JsonObject, type JsonValue, type Settings } from '@/packages/schema'

export const SECRET_SETTINGS_FIELDS = [
  'aria2Secret',
  'convexSyncSecret',
  'gdriveClientSecret',
  'gdriveAccessToken',
  'gdriveRefreshToken',
  'gdriveTokenExpiry',
  'dropboxAccessToken',
  'dropboxRefreshToken',
  'dropboxTokenExpiry',
] as const satisfies ReadonlyArray<keyof Settings>

export type SecretSettingsField = (typeof SECRET_SETTINGS_FIELDS)[number]
export type PageSettings = Omit<Settings, SecretSettingsField>

export interface SplitSettings {
  readonly publicPart: JsonObject
  readonly secretPart: JsonObject
}

const SECRET_FIELD_SET: ReadonlySet<string> = new Set(SECRET_SETTINGS_FIELDS)

export const splitSettings = (merged: JsonValue): SplitSettings => {
  const publicPart: Record<string, JsonValue> = {}
  const secretPart: Record<string, JsonValue> = {}
  if (isJsonObject(merged)) {
    for (const [key, value] of Object.entries(merged)) {
      if (SECRET_FIELD_SET.has(key)) secretPart[key] = value
      else publicPart[key] = value
    }
  }
  return { publicPart, secretPart }
}

export const mergeSettings = (publicRaw: JsonValue, secretsRaw: JsonValue) => {
  const merged: Record<string, JsonValue> = {}
  if (isJsonObject(publicRaw)) {
    for (const [key, value] of Object.entries(publicRaw)) merged[key] = value
  }
  if (isJsonObject(secretsRaw)) {
    for (const [key, value] of Object.entries(secretsRaw)) merged[key] = value
  }
  return merged satisfies JsonObject
}

export const hasSecretField = (publicRaw: JsonValue): boolean =>
  isJsonObject(publicRaw) && Object.keys(publicRaw).some((key) => SECRET_FIELD_SET.has(key))
