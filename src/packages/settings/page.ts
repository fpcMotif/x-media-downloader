import { Option, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import { Settings as SettingsSchema, type JsonValue } from '@/packages/schema'
import { normalizeFilenameTemplate } from './lib/template-migration'
import { splitSettings, type PageSettings } from './lib/secret-fields'

export type { PageSettings } from './lib/secret-fields'

const pageItem = storage.defineItem<JsonValue>('local:settings', { fallback: {} })

const decodePage = (raw: JsonValue): PageSettings => {
  const { publicPart } = splitSettings(raw)
  const decoded = Schema.decodeUnknownOption(SettingsSchema)(publicPart)
  const settings = Option.isSome(decoded)
    ? decoded.value
    : Schema.decodeUnknownSync(SettingsSchema)({})
  return { ...settings, filenameTemplate: normalizeFilenameTemplate(settings.filenameTemplate) }
}

export const getPageSettings = (): Promise<PageSettings> =>
  pageItem.getValue().then(decodePage, () => decodePage({}))

export const watchPageSettings = (cb: (s: PageSettings) => void): (() => void) =>
  pageItem.watch((raw) => {
    cb(decodePage(raw))
  })
