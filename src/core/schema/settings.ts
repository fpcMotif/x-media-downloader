import { Effect, Result, Schema } from 'effect'
import { MediaType } from './media'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { hasWireKeys, isWireRecord } from '../wire/exact'

export const CURRENT_DEFAULT_TEMPLATE = '{platform}/{tweetId}_{index}.{ext}'

export const MAX_SETTINGS_PATCH_BYTES = 32 * 1024
export const MAX_SETTINGS_RESPONSE_BYTES = 128 * 1024
export const MAX_SETTINGS_FAILURE_REASON_LENGTH = 512
export const MAX_FILENAME_TEMPLATE_LENGTH = 4_096
export const MAX_SETTINGS_URL_LENGTH = 8_192
export const MAX_SETTINGS_SECRET_LENGTH = 4_096
export const MAX_ARIA2_DIR_LENGTH = 4_096
export const MAX_CLOUD_DEVICE_ID_LENGTH = 64
export const MAX_OAUTH_CLIENT_ID_LENGTH = 2_048
export const MAX_OAUTH_TOKEN_LENGTH = 16_384
export const MAX_CLOUD_FOLDER_ID_LENGTH = 1_024
export const MAX_CLOUD_ACCOUNT_LENGTH = 1_024
export const MAX_MEDIA_DIMENSION = 1_000_000
export const MAX_MB_SETTING = Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024))

export const DownloadStrategyName = Schema.Literals(['direct', 'fetched', 'aria2'])
export type DownloadStrategyName = typeof DownloadStrategyName.Type
export const Theme = Schema.Literals(['light', 'dark', 'system'])
export type Theme = typeof Theme.Type
export const QuickGrabModifier = Schema.Literals(['alt', 'shift', 'ctrl', 'meta'])
export type QuickGrabModifier = typeof QuickGrabModifier.Type

const boundedText = (maximum: number) =>
  Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))
const boundedSafeInteger = (minimum: number, maximum: number) =>
  Schema.Number.pipe(
    Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isBetween({ minimum, maximum })),
  )
const nonNegativeSafeInteger = boundedSafeInteger(0, Number.MAX_SAFE_INTEGER)
const nonNegativeMb = Schema.Number.pipe(
  Schema.check(
    Schema.isFinite(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_MB_SETTING),
  ),
)
const settingFields = {
  filenameTemplate: boundedText(MAX_FILENAME_TEMPLATE_LENGTH),
  downloadConcurrency: boundedSafeInteger(1, 10),
  downloadStrategy: DownloadStrategyName,
  theme: Theme,
  quickGrabEnabled: Schema.Boolean,
  quickGrabModifier: QuickGrabModifier,
  downloadBadgeEnabled: Schema.Boolean,
  downloadDockEnabled: Schema.Boolean,
  dockGlassEnabled: Schema.Boolean,
  showSavedStatus: Schema.Boolean,
  autoRevealSensitiveEnabled: Schema.Boolean,
  sidecarMetadata: Schema.Boolean,
  aria2RpcUrl: boundedText(MAX_SETTINGS_URL_LENGTH),
  aria2Secret: boundedText(MAX_SETTINGS_SECRET_LENGTH),
  aria2Dir: boundedText(MAX_ARIA2_DIR_LENGTH),
  aria2Split: boundedSafeInteger(1, 16),
  cloudSyncEnabled: Schema.Boolean,
  convexUrl: boundedText(MAX_SETTINGS_URL_LENGTH),
  convexSyncSecret: boundedText(MAX_SETTINGS_SECRET_LENGTH),
  cloudDeviceId: boundedText(MAX_CLOUD_DEVICE_ID_LENGTH),
  downloadHistoryEnabled: Schema.Boolean,
  clearOnSave: Schema.Boolean,
  autoUnbookmarkOnSave: Schema.Boolean,
  autoUnlikeOnSave: Schema.Boolean,
  autoNotInterestedOnSave: Schema.Boolean,
  clearAllListsOnSave: Schema.Boolean,
  cloudUploadEnabled: Schema.Boolean,
  gdriveClientId: boundedText(MAX_OAUTH_CLIENT_ID_LENGTH),
  gdriveAccessToken: boundedText(MAX_OAUTH_TOKEN_LENGTH),
  gdriveRefreshToken: boundedText(MAX_OAUTH_TOKEN_LENGTH),
  gdriveTokenExpiry: nonNegativeSafeInteger,
  gdriveFolderId: boundedText(MAX_CLOUD_FOLDER_ID_LENGTH),
  gdriveAccount: boundedText(MAX_CLOUD_ACCOUNT_LENGTH),
  dropboxClientId: boundedText(MAX_OAUTH_CLIENT_ID_LENGTH),
  dropboxAccessToken: boundedText(MAX_OAUTH_TOKEN_LENGTH),
  dropboxRefreshToken: boundedText(MAX_OAUTH_TOKEN_LENGTH),
  dropboxTokenExpiry: nonNegativeSafeInteger,
  dropboxAccount: boundedText(MAX_CLOUD_ACCOUNT_LENGTH),
  preventDuplicateDownloads: Schema.Boolean,
  skipTypes: Schema.Array(MediaType).pipe(Schema.check(Schema.isMaxLength(3), Schema.isUnique())),
  minWidth: boundedSafeInteger(0, MAX_MEDIA_DIMENSION),
  minHeight: boundedSafeInteger(0, MAX_MEDIA_DIMENSION),
  maxFileSizeMB: nonNegativeMb,
  dailyMaxMB: nonNegativeMb,
  dailyMaxCount: nonNegativeSafeInteger,
  captureEnabled: Schema.Boolean,
  captureAllScrolled: Schema.Boolean,
  captureMirrorEnabled: Schema.Boolean,
} as const

const settingsFields = {
  filenameTemplate: settingFields.filenameTemplate.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(CURRENT_DEFAULT_TEMPLATE)),
  ),
  downloadConcurrency: settingFields.downloadConcurrency.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(3)),
  ),
  downloadStrategy: settingFields.downloadStrategy.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('direct')),
  ),
  theme: settingFields.theme.pipe(Schema.withDecodingDefaultKey(Effect.succeed('system'))),
  quickGrabEnabled: settingFields.quickGrabEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  quickGrabModifier: settingFields.quickGrabModifier.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('alt')),
  ),
  downloadBadgeEnabled: settingFields.downloadBadgeEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  downloadDockEnabled: settingFields.downloadDockEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  dockGlassEnabled: settingFields.dockGlassEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  showSavedStatus: settingFields.showSavedStatus.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  autoRevealSensitiveEnabled: settingFields.autoRevealSensitiveEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  sidecarMetadata: settingFields.sidecarMetadata.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  aria2RpcUrl: settingFields.aria2RpcUrl.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('http://localhost:6800/jsonrpc')),
  ),
  aria2Secret: settingFields.aria2Secret.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  aria2Dir: settingFields.aria2Dir.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  aria2Split: settingFields.aria2Split.pipe(Schema.withDecodingDefaultKey(Effect.succeed(8))),
  cloudSyncEnabled: settingFields.cloudSyncEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  convexUrl: settingFields.convexUrl.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  convexSyncSecret: settingFields.convexSyncSecret.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  cloudDeviceId: settingFields.cloudDeviceId.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  downloadHistoryEnabled: settingFields.downloadHistoryEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  clearOnSave: settingFields.clearOnSave.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  autoUnbookmarkOnSave: settingFields.autoUnbookmarkOnSave.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  autoUnlikeOnSave: settingFields.autoUnlikeOnSave.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  autoNotInterestedOnSave: settingFields.autoNotInterestedOnSave.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  clearAllListsOnSave: settingFields.clearAllListsOnSave.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  cloudUploadEnabled: settingFields.cloudUploadEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  gdriveClientId: settingFields.gdriveClientId.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  gdriveAccessToken: settingFields.gdriveAccessToken.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  gdriveRefreshToken: settingFields.gdriveRefreshToken.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  gdriveTokenExpiry: settingFields.gdriveTokenExpiry.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  gdriveFolderId: settingFields.gdriveFolderId.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  gdriveAccount: settingFields.gdriveAccount.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  dropboxClientId: settingFields.dropboxClientId.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  dropboxAccessToken: settingFields.dropboxAccessToken.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  dropboxRefreshToken: settingFields.dropboxRefreshToken.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  dropboxTokenExpiry: settingFields.dropboxTokenExpiry.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  dropboxAccount: settingFields.dropboxAccount.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('')),
  ),
  preventDuplicateDownloads: settingFields.preventDuplicateDownloads.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  skipTypes: settingFields.skipTypes.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  minWidth: settingFields.minWidth.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  minHeight: settingFields.minHeight.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  maxFileSizeMB: settingFields.maxFileSizeMB.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  dailyMaxMB: settingFields.dailyMaxMB.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  dailyMaxCount: settingFields.dailyMaxCount.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  captureEnabled: settingFields.captureEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  captureAllScrolled: settingFields.captureAllScrolled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  captureMirrorEnabled: settingFields.captureMirrorEnabled.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
} as const

export const Settings = Schema.Struct(settingsFields)
export type Settings = typeof Settings.Type
export const SETTINGS_DEFAULTS = Schema.decodeUnknownSync(Settings as never)({}) as Settings
export const SETTINGS_KEYS = Object.keys(settingFields) as Array<keyof Settings>

const optional = Schema.optional
/** Fields a person may change from popup or options. Provider credentials,
 * connection metadata, and the sync device identity stay background-owned. */
const uiSettingsFields = {
  filenameTemplate: settingFields.filenameTemplate,
  downloadConcurrency: settingFields.downloadConcurrency,
  downloadStrategy: settingFields.downloadStrategy,
  theme: settingFields.theme,
  quickGrabEnabled: settingFields.quickGrabEnabled,
  quickGrabModifier: settingFields.quickGrabModifier,
  downloadBadgeEnabled: settingFields.downloadBadgeEnabled,
  downloadDockEnabled: settingFields.downloadDockEnabled,
  dockGlassEnabled: settingFields.dockGlassEnabled,
  showSavedStatus: settingFields.showSavedStatus,
  autoRevealSensitiveEnabled: settingFields.autoRevealSensitiveEnabled,
  sidecarMetadata: settingFields.sidecarMetadata,
  aria2RpcUrl: settingFields.aria2RpcUrl,
  aria2Secret: settingFields.aria2Secret,
  aria2Dir: settingFields.aria2Dir,
  aria2Split: settingFields.aria2Split,
  cloudSyncEnabled: settingFields.cloudSyncEnabled,
  convexUrl: settingFields.convexUrl,
  convexSyncSecret: settingFields.convexSyncSecret,
  downloadHistoryEnabled: settingFields.downloadHistoryEnabled,
  clearOnSave: settingFields.clearOnSave,
  autoUnbookmarkOnSave: settingFields.autoUnbookmarkOnSave,
  autoUnlikeOnSave: settingFields.autoUnlikeOnSave,
  autoNotInterestedOnSave: settingFields.autoNotInterestedOnSave,
  clearAllListsOnSave: settingFields.clearAllListsOnSave,
  cloudUploadEnabled: settingFields.cloudUploadEnabled,
  preventDuplicateDownloads: settingFields.preventDuplicateDownloads,
  skipTypes: settingFields.skipTypes,
  minWidth: settingFields.minWidth,
  minHeight: settingFields.minHeight,
  maxFileSizeMB: settingFields.maxFileSizeMB,
  dailyMaxMB: settingFields.dailyMaxMB,
  dailyMaxCount: settingFields.dailyMaxCount,
  captureEnabled: settingFields.captureEnabled,
  captureAllScrolled: settingFields.captureAllScrolled,
  captureMirrorEnabled: settingFields.captureMirrorEnabled,
} as const
const UI_SETTINGS_KEYS = Object.keys(uiSettingsFields)

/** Field-specific, optional patch accepted from trusted UI surfaces only. */
export const SettingsUiPatch = Schema.Struct({
  filenameTemplate: optional(uiSettingsFields.filenameTemplate),
  downloadConcurrency: optional(uiSettingsFields.downloadConcurrency),
  downloadStrategy: optional(uiSettingsFields.downloadStrategy),
  theme: optional(uiSettingsFields.theme),
  quickGrabEnabled: optional(uiSettingsFields.quickGrabEnabled),
  quickGrabModifier: optional(uiSettingsFields.quickGrabModifier),
  downloadBadgeEnabled: optional(uiSettingsFields.downloadBadgeEnabled),
  downloadDockEnabled: optional(uiSettingsFields.downloadDockEnabled),
  dockGlassEnabled: optional(uiSettingsFields.dockGlassEnabled),
  showSavedStatus: optional(uiSettingsFields.showSavedStatus),
  autoRevealSensitiveEnabled: optional(uiSettingsFields.autoRevealSensitiveEnabled),
  sidecarMetadata: optional(uiSettingsFields.sidecarMetadata),
  aria2RpcUrl: optional(uiSettingsFields.aria2RpcUrl),
  aria2Secret: optional(uiSettingsFields.aria2Secret),
  aria2Dir: optional(uiSettingsFields.aria2Dir),
  aria2Split: optional(uiSettingsFields.aria2Split),
  cloudSyncEnabled: optional(uiSettingsFields.cloudSyncEnabled),
  convexUrl: optional(uiSettingsFields.convexUrl),
  convexSyncSecret: optional(uiSettingsFields.convexSyncSecret),
  downloadHistoryEnabled: optional(uiSettingsFields.downloadHistoryEnabled),
  clearOnSave: optional(uiSettingsFields.clearOnSave),
  autoUnbookmarkOnSave: optional(uiSettingsFields.autoUnbookmarkOnSave),
  autoUnlikeOnSave: optional(uiSettingsFields.autoUnlikeOnSave),
  autoNotInterestedOnSave: optional(uiSettingsFields.autoNotInterestedOnSave),
  clearAllListsOnSave: optional(uiSettingsFields.clearAllListsOnSave),
  cloudUploadEnabled: optional(uiSettingsFields.cloudUploadEnabled),
  preventDuplicateDownloads: optional(uiSettingsFields.preventDuplicateDownloads),
  skipTypes: optional(uiSettingsFields.skipTypes),
  minWidth: optional(uiSettingsFields.minWidth),
  minHeight: optional(uiSettingsFields.minHeight),
  maxFileSizeMB: optional(uiSettingsFields.maxFileSizeMB),
  dailyMaxMB: optional(uiSettingsFields.dailyMaxMB),
  dailyMaxCount: optional(uiSettingsFields.dailyMaxCount),
  captureEnabled: optional(uiSettingsFields.captureEnabled),
  captureAllScrolled: optional(uiSettingsFields.captureAllScrolled),
  captureMirrorEnabled: optional(uiSettingsFields.captureMirrorEnabled),
})
export type SettingsUiPatch = typeof SettingsUiPatch.Type

/** Field-specific, optional, known-key patch schema. Exactness is enforced by the decoder. */
export const SettingsPatch = Schema.Struct({
  filenameTemplate: optional(settingFields.filenameTemplate),
  downloadConcurrency: optional(settingFields.downloadConcurrency),
  downloadStrategy: optional(settingFields.downloadStrategy),
  theme: optional(settingFields.theme),
  quickGrabEnabled: optional(settingFields.quickGrabEnabled),
  quickGrabModifier: optional(settingFields.quickGrabModifier),
  downloadBadgeEnabled: optional(settingFields.downloadBadgeEnabled),
  downloadDockEnabled: optional(settingFields.downloadDockEnabled),
  dockGlassEnabled: optional(settingFields.dockGlassEnabled),
  showSavedStatus: optional(settingFields.showSavedStatus),
  autoRevealSensitiveEnabled: optional(settingFields.autoRevealSensitiveEnabled),
  sidecarMetadata: optional(settingFields.sidecarMetadata),
  aria2RpcUrl: optional(settingFields.aria2RpcUrl),
  aria2Secret: optional(settingFields.aria2Secret),
  aria2Dir: optional(settingFields.aria2Dir),
  aria2Split: optional(settingFields.aria2Split),
  cloudSyncEnabled: optional(settingFields.cloudSyncEnabled),
  convexUrl: optional(settingFields.convexUrl),
  convexSyncSecret: optional(settingFields.convexSyncSecret),
  cloudDeviceId: optional(settingFields.cloudDeviceId),
  downloadHistoryEnabled: optional(settingFields.downloadHistoryEnabled),
  clearOnSave: optional(settingFields.clearOnSave),
  autoUnbookmarkOnSave: optional(settingFields.autoUnbookmarkOnSave),
  autoUnlikeOnSave: optional(settingFields.autoUnlikeOnSave),
  autoNotInterestedOnSave: optional(settingFields.autoNotInterestedOnSave),
  clearAllListsOnSave: optional(settingFields.clearAllListsOnSave),
  cloudUploadEnabled: optional(settingFields.cloudUploadEnabled),
  gdriveClientId: optional(settingFields.gdriveClientId),
  gdriveAccessToken: optional(settingFields.gdriveAccessToken),
  gdriveRefreshToken: optional(settingFields.gdriveRefreshToken),
  gdriveTokenExpiry: optional(settingFields.gdriveTokenExpiry),
  gdriveFolderId: optional(settingFields.gdriveFolderId),
  gdriveAccount: optional(settingFields.gdriveAccount),
  dropboxClientId: optional(settingFields.dropboxClientId),
  dropboxAccessToken: optional(settingFields.dropboxAccessToken),
  dropboxRefreshToken: optional(settingFields.dropboxRefreshToken),
  dropboxTokenExpiry: optional(settingFields.dropboxTokenExpiry),
  dropboxAccount: optional(settingFields.dropboxAccount),
  preventDuplicateDownloads: optional(settingFields.preventDuplicateDownloads),
  skipTypes: optional(settingFields.skipTypes),
  minWidth: optional(settingFields.minWidth),
  minHeight: optional(settingFields.minHeight),
  maxFileSizeMB: optional(settingFields.maxFileSizeMB),
  dailyMaxMB: optional(settingFields.dailyMaxMB),
  dailyMaxCount: optional(settingFields.dailyMaxCount),
  captureEnabled: optional(settingFields.captureEnabled),
  captureAllScrolled: optional(settingFields.captureAllScrolled),
  captureMirrorEnabled: optional(settingFields.captureMirrorEnabled),
})
export type SettingsPatch = typeof SettingsPatch.Type

export const decodeSettingsPatch = (raw: unknown): Partial<Settings> => {
  if (!isWireRecord(raw)) throw new Error('Settings patch must be an object')
  const keys = Object.keys(raw)
  if (keys.some((key) => !SETTINGS_KEYS.includes(key as keyof Settings)))
    throw new Error(
      `Unknown settings key: ${keys.find((key) => !SETTINGS_KEYS.includes(key as keyof Settings))}`,
    )
  try {
    return Schema.decodeUnknownSync(SettingsPatch as never, { onExcessProperty: 'error' })(
      raw,
    ) as Partial<Settings>
  } catch {
    throw new Error('Expected valid Settings patch')
  }
}

const decodeSettingsUiPatch = (raw: unknown): SettingsUiPatch => {
  if (!isWireRecord(raw)) throw new Error('Settings patch must be an object')
  const keys = Object.keys(raw)
  if (keys.some((key) => !UI_SETTINGS_KEYS.includes(key)))
    throw new Error('Settings patch includes a background-owned field')
  try {
    return Schema.decodeUnknownSync(SettingsUiPatch as never, { onExcessProperty: 'error' })(
      raw,
    ) as SettingsUiPatch
  } catch {
    throw new Error('Expected valid Settings patch')
  }
}

export const SettingsUpdateRequest = Schema.TaggedStruct('SettingsUpdateRequest', {
  patch: SettingsUiPatch,
})
export type SettingsUpdateRequest = typeof SettingsUpdateRequest.Type
export const decodeSettingsUpdateRequest = (value: unknown): SettingsUpdateRequest | undefined => {
  if (!isJsonWithinByteBudget(value, MAX_SETTINGS_PATCH_BYTES)) return undefined
  if (
    !isWireRecord(value) ||
    value._tag !== 'SettingsUpdateRequest' ||
    !hasWireKeys(value, ['_tag', 'patch'])
  )
    return undefined
  try {
    return { _tag: 'SettingsUpdateRequest', patch: decodeSettingsUiPatch(value.patch) }
  } catch {
    return undefined
  }
}
export const SettingsUpdateSuccess = Schema.TaggedStruct('SettingsUpdateSuccess', {
  settings: Schema.Struct(settingFields),
})
export type SettingsUpdateSuccess = typeof SettingsUpdateSuccess.Type
export const SettingsUpdateFailure = Schema.TaggedStruct('SettingsUpdateFailure', {
  reason: boundedText(MAX_SETTINGS_FAILURE_REASON_LENGTH),
})
export type SettingsUpdateFailure = typeof SettingsUpdateFailure.Type
export const SettingsUpdateResponse = Schema.Union([SettingsUpdateSuccess, SettingsUpdateFailure])
export type SettingsUpdateResponse = typeof SettingsUpdateResponse.Type

/** Decode the Settings command reply exactly. Durable snapshots may default one
 * corrupt field; a worker acknowledgement must instead be complete and current. */
export const decodeSettingsUpdateResponse = (
  value: unknown,
): SettingsUpdateResponse | undefined => {
  if (!isJsonWithinByteBudget(value, MAX_SETTINGS_RESPONSE_BYTES) || !isWireRecord(value))
    return undefined
  if (value._tag === 'SettingsUpdateFailure') {
    if (!hasWireKeys(value, ['_tag', 'reason'])) return undefined
  } else if (value._tag === 'SettingsUpdateSuccess') {
    if (!hasWireKeys(value, ['_tag', 'settings']) || !isWireRecord(value.settings)) return undefined
    if (!hasWireKeys(value.settings, SETTINGS_KEYS)) return undefined
  } else return undefined
  const decoded = Schema.decodeUnknownResult(SettingsUpdateResponse)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}
export const SettingsReadRequest = Schema.TaggedStruct('SettingsReadRequest', {})
export type SettingsReadRequest = typeof SettingsReadRequest.Type

const contentSettingsFields = {
  quickGrabEnabled: Schema.Boolean,
  quickGrabModifier: QuickGrabModifier,
  downloadBadgeEnabled: Schema.Boolean,
  downloadDockEnabled: Schema.Boolean,
  dockGlassEnabled: Schema.Boolean,
  autoRevealSensitiveEnabled: Schema.Boolean,
  clearOnSave: Schema.Boolean,
  autoNotInterestedOnSave: Schema.Boolean,
  showSavedStatus: Schema.Boolean,
  captureEnabled: Schema.Boolean,
  captureAllScrolled: Schema.Boolean,
  autoUnbookmarkOnSave: Schema.Boolean,
  autoUnlikeOnSave: Schema.Boolean,
  downloadStrategy: DownloadStrategyName,
} as const
export const ContentSettings = Schema.Struct(contentSettingsFields)
export type ContentSettings = typeof ContentSettings.Type
const CONTENT_SETTINGS_KEYS = Object.keys(contentSettingsFields)
export const projectContentSettings = (settings: Settings): ContentSettings => ({
  quickGrabEnabled: settings.quickGrabEnabled,
  quickGrabModifier: settings.quickGrabModifier,
  downloadBadgeEnabled: settings.downloadBadgeEnabled,
  downloadDockEnabled: settings.downloadDockEnabled,
  dockGlassEnabled: settings.dockGlassEnabled,
  autoRevealSensitiveEnabled: settings.autoRevealSensitiveEnabled,
  clearOnSave: settings.clearOnSave,
  autoNotInterestedOnSave: settings.autoNotInterestedOnSave,
  showSavedStatus: settings.showSavedStatus,
  captureEnabled: settings.captureEnabled,
  captureAllScrolled: settings.captureAllScrolled,
  autoUnbookmarkOnSave: settings.autoUnbookmarkOnSave,
  autoUnlikeOnSave: settings.autoUnlikeOnSave,
  downloadStrategy: settings.downloadStrategy,
})
export const SettingsReadSuccess = Schema.TaggedStruct('SettingsReadSuccess', {
  settings: ContentSettings,
})
export type SettingsReadSuccess = typeof SettingsReadSuccess.Type
export const SettingsReadUnavailable = Schema.TaggedStruct('SettingsReadUnavailable', {})
export type SettingsReadUnavailable = typeof SettingsReadUnavailable.Type
export const SettingsReadResponse = Schema.Union([SettingsReadSuccess, SettingsReadUnavailable])
export type SettingsReadResponse = typeof SettingsReadResponse.Type
export const SettingsChanged = Schema.TaggedStruct('SettingsChanged', { settings: ContentSettings })
export type SettingsChanged = typeof SettingsChanged.Type
export const decodeSettingsReadRequest = (value: unknown): SettingsReadRequest | undefined =>
  isWireRecord(value) && value._tag === 'SettingsReadRequest' && hasWireKeys(value, ['_tag'])
    ? (value as SettingsReadRequest)
    : undefined
const decodeContentSettingsPayload = (value: unknown): ContentSettings | undefined => {
  if (!isWireRecord(value) || !hasWireKeys(value, CONTENT_SETTINGS_KEYS)) return undefined
  const decoded = Schema.decodeUnknownResult(ContentSettings)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}
export const decodeSettingsReadResponse = (value: unknown): SettingsReadResponse | undefined => {
  if (!isWireRecord(value)) return undefined
  if (value._tag === 'SettingsReadUnavailable')
    return hasWireKeys(value, ['_tag']) ? (value as SettingsReadUnavailable) : undefined
  if (value._tag !== 'SettingsReadSuccess' || !hasWireKeys(value, ['_tag', 'settings']))
    return undefined
  const settings = decodeContentSettingsPayload(value.settings)
  return settings === undefined ? undefined : { _tag: 'SettingsReadSuccess', settings }
}
export const decodeSettingsChanged = (value: unknown): SettingsChanged | undefined => {
  if (
    !isWireRecord(value) ||
    value._tag !== 'SettingsChanged' ||
    !hasWireKeys(value, ['_tag', 'settings'])
  )
    return undefined
  const settings = decodeContentSettingsPayload(value.settings)
  return settings === undefined ? undefined : { _tag: 'SettingsChanged', settings }
}
