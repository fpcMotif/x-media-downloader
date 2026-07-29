import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { Settings as SettingsSchema, type Settings } from '../core/schema'
import { decodeSettingsStore } from '../core/settings/persistence'
import type { SettingsRecord } from '../core/settings/storage'
import { makeSettingsWriter } from './settings-writer'

const defaults = Schema.decodeUnknownSync(SettingsSchema)({})

function memoryRecord(initial: unknown = {}): SettingsRecord & {
  readonly writes: unknown[]
  readonly current: () => unknown
} {
  let value = initial
  const writes: unknown[] = []
  return {
    get: async () => value,
    set: async (next) => {
      value = next
      writes.push(next)
    },
    writes,
    current: () => value,
  }
}

const settingsFrom = (raw: unknown): Settings => decodeSettingsStore(raw).settings

describe('SettingsWriter', () => {
  it('fresh-reads each FIFO task so interleaved patches both survive', async () => {
    let releaseFirstWrite!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let signalFirstWrite!: () => void
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWrite = resolve
    })
    let calls = 0
    let value: unknown = {}
    const record: SettingsRecord = {
      get: async () => value,
      set: async (next) => {
        calls += 1
        if (calls === 1) {
          signalFirstWrite()
          await firstWrite
        }
        value = next
      },
    }
    const writer = makeSettingsWriter(record)

    const first = writer.update({ downloadConcurrency: 7 })
    const second = writer.update({ theme: 'dark' })
    await firstWriteStarted
    releaseFirstWrite()

    await expect(first).resolves.toMatchObject({ downloadConcurrency: 7 })
    await expect(second).resolves.toMatchObject({ downloadConcurrency: 7, theme: 'dark' })
  })

  it('recovers after a rejected write', async () => {
    let fail = true
    let value: unknown = {}
    const record: SettingsRecord = {
      get: async () => value,
      set: async (next) => {
        if (fail) {
          fail = false
          throw new Error('disk full')
        }
        value = next
      },
    }
    const writer = makeSettingsWriter(record)

    await expect(writer.update({ theme: 'dark' })).rejects.toThrow('disk full')
    await expect(writer.update({ downloadConcurrency: 5 })).resolves.toMatchObject({
      downloadConcurrency: 5,
    })
  })

  it('rejects malformed patches without writing', async () => {
    const record = memoryRecord()
    const writer = makeSettingsWriter(record)

    await expect(writer.update({ nope: true } as never)).rejects.toThrow(
      'Unknown settings key: nope',
    )
    await expect(writer.update({ downloadConcurrency: 'fast' } as never)).rejects.toThrow(
      'Expected valid Settings patch',
    )
    expect(record.writes).toEqual([])
  })

  it('rejects fractional concurrency before any durable write', async () => {
    const record = memoryRecord()
    const writer = makeSettingsWriter(record)

    await expect(writer.update({ downloadConcurrency: 2.5 })).rejects.toThrow(
      'Expected valid Settings patch',
    )
    expect(record.writes).toEqual([])
  })

  it('validates a guarded patch before deciding not to write', async () => {
    const record = memoryRecord()
    const writer = makeSettingsWriter(record)

    await expect(writer.updateWhen(() => false, { aria2Split: 8.5 })).rejects.toThrow(
      'Expected valid Settings patch',
    )
    expect(record.writes).toEqual([])
  })

  it('normalizes legacy templates before committing', async () => {
    const record = memoryRecord({ filenameTemplate: '{handle}/{tweetId}_{index}.{ext}' })
    const writer = makeSettingsWriter(record)

    await expect(writer.update({ theme: 'dark' })).resolves.toMatchObject({
      filenameTemplate: defaults.filenameTemplate,
      theme: 'dark',
    })
    expect(record.writes[0]).toMatchObject({
      version: 1,
      revision: 1,
      settings: { filenameTemplate: defaults.filenameTemplate },
    })
  })

  it('does not write when updateWhen sees a false guard', async () => {
    const record = memoryRecord({ cloudUploadEnabled: false })
    const writer = makeSettingsWriter(record)

    await expect(
      writer.updateWhen((current) => current.cloudUploadEnabled, { gdriveFolderId: 'folder' }),
    ).resolves.toEqual({
      applied: false,
      settings: expect.objectContaining({ cloudUploadEnabled: false }),
    })
    expect(record.writes).toEqual([])
  })

  it('keeps worker-owned provider fields available to internal callers', async () => {
    const record = memoryRecord()
    const writer = makeSettingsWriter(record)

    await expect(
      writer.update({ gdriveRefreshToken: 'worker-issued-refresh-token' }),
    ).resolves.toMatchObject({ gdriveRefreshToken: 'worker-issued-refresh-token' })
  })

  it('checks the updateWhen guard inside the queue', async () => {
    const record = memoryRecord({ cloudUploadEnabled: false })
    const writer = makeSettingsWriter(record)

    const enable = writer.update({ cloudUploadEnabled: true })
    const guarded = writer.updateWhen((current) => current.cloudUploadEnabled, {
      gdriveFolderId: 'folder',
    })

    await expect(enable).resolves.toMatchObject({ cloudUploadEnabled: true })
    await expect(guarded).resolves.toEqual({
      applied: true,
      settings: expect.objectContaining({ cloudUploadEnabled: true, gdriveFolderId: 'folder' }),
    })
  })

  it('provisions sync identity in the same commit that enables sync', async () => {
    const record = memoryRecord()
    const writer = makeSettingsWriter(record, () => 'device-owned')

    await expect(writer.update({ cloudSyncEnabled: true })).resolves.toMatchObject({
      cloudSyncEnabled: true,
      cloudDeviceId: 'device-owned',
    })
    expect(record.writes).toHaveLength(1)
  })

  it('provisions identity when Capture Mirror is enabled without Media Sync', async () => {
    const record = memoryRecord({ cloudSyncEnabled: false })
    const writer = makeSettingsWriter(record, () => 'capture-device')

    await expect(writer.update({ captureMirrorEnabled: true })).resolves.toMatchObject({
      cloudSyncEnabled: false,
      captureMirrorEnabled: true,
      cloudDeviceId: 'capture-device',
    })
    expect(record.writes).toHaveLength(1)
  })

  it('keeps an existing identity', async () => {
    const record = memoryRecord({ cloudDeviceId: 'stable-device' })
    const writer = makeSettingsWriter(record, () => {
      throw new Error('must not replace identity')
    })

    await expect(writer.update({ cloudSyncEnabled: true })).resolves.toMatchObject({
      cloudDeviceId: 'stable-device',
    })
  })

  it('repairs legacy enabled snapshots once', async () => {
    const record = memoryRecord({ captureMirrorEnabled: true, cloudDeviceId: '' })
    const writer = makeSettingsWriter(record, () => 'repaired-device')

    await expect(writer.ensureInvariants()).resolves.toMatchObject({
      cloudDeviceId: 'repaired-device',
    })
    await writer.ensureInvariants()
    expect(record.writes).toHaveLength(1)
  })

  it('migrates valid legacy Settings once even when no invariant field changes', async () => {
    const record = memoryRecord({ theme: 'dark' })
    const writer = makeSettingsWriter(record)

    await expect(writer.ensureInvariants()).resolves.toMatchObject({ theme: 'dark' })
    await writer.ensureInvariants()
    expect(record.writes).toHaveLength(1)
    expect(record.writes[0]).toMatchObject({
      version: 1,
      revision: 1,
      settings: { theme: 'dark' },
    })
  })

  it('never rewrites recoverable raw data during boot invariants', async () => {
    const raw = {
      cloudSyncEnabled: true,
      downloadConcurrency: 'fast',
      futureSetting: 'keep',
    }
    const record = memoryRecord(raw)
    const writer = makeSettingsWriter(record)

    await expect(writer.ensureInvariants()).resolves.toMatchObject({
      cloudSyncEnabled: false,
      downloadConcurrency: defaults.downloadConcurrency,
    })
    expect(record.current()).toBe(raw)
    expect(record.writes).toEqual([])
  })

  it('runs a clear policy turn after prior writes and before later writes', async () => {
    const record = memoryRecord()
    const writer = makeSettingsWriter(record)
    let releaseTurn!: () => void
    const turnCanFinish = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    let signalTurn!: () => void
    const turnStarted = new Promise<void>((resolve) => {
      signalTurn = resolve
    })

    const before = writer.update({ clearOnSave: true })
    const turn = writer.withSnapshotTurn(async (current) => {
      expect(current.clearOnSave).toBe(true)
      signalTurn()
      await turnCanFinish
    })
    const after = writer.update({ clearOnSave: false })

    await before
    await turnStarted
    expect(record.writes).toHaveLength(1)
    expect(settingsFrom(record.writes[0]).clearOnSave).toBe(true)

    releaseTurn()
    await turn
    await after
    expect(record.writes.map((raw) => settingsFrom(raw).clearOnSave)).toEqual([true, false])
  })

  it('preserves unrelated corrupt, unknown, and token values on ordinary updates', async () => {
    const record = memoryRecord({
      theme: 'dark',
      downloadConcurrency: 'fast',
      downloadStrategy: 'aria2',
      cloudUploadEnabled: true,
      gdriveRefreshToken: 'opaque-token',
      futureSetting: { keep: true },
    })
    const writer = makeSettingsWriter(record)

    await expect(writer.update({ theme: 'light' })).resolves.toMatchObject({
      theme: 'light',
      downloadConcurrency: defaults.downloadConcurrency,
      downloadStrategy: 'direct',
      cloudUploadEnabled: false,
      gdriveRefreshToken: 'opaque-token',
    })
    expect(record.writes).toEqual([
      {
        theme: 'light',
        downloadConcurrency: 'fast',
        downloadStrategy: 'aria2',
        cloudUploadEnabled: true,
        gdriveRefreshToken: 'opaque-token',
        futureSetting: { keep: true },
      },
    ])
  })

  it('refuses to rewrite an unsupported Settings version', async () => {
    const record = memoryRecord({
      version: 99,
      revision: 1,
      settings: { ...defaults, theme: 'dark' },
    })
    const writer = makeSettingsWriter(record)

    await expect(writer.update({ theme: 'light' })).rejects.toMatchObject({
      name: 'SettingsRecoveryRequiredError',
    })
    expect(record.writes).toEqual([])
  })

  it('canonicalizes once a named patch repairs the last invalid field', async () => {
    const record = memoryRecord({ downloadConcurrency: 'fast' })
    const writer = makeSettingsWriter(record)

    await expect(writer.update({ downloadConcurrency: 6 })).resolves.toMatchObject({
      downloadConcurrency: 6,
    })
    expect(record.writes[0]).toMatchObject({
      version: 1,
      revision: 1,
      settings: { downloadConcurrency: 6 },
    })
  })

  it('repairs only after an exact fingerprint and keeps valid credential fields', async () => {
    const record = memoryRecord({
      downloadConcurrency: 'fast',
      cloudUploadEnabled: true,
      gdriveRefreshToken: 'opaque-token',
      futureSetting: 'drop-on-confirmed-repair',
    })
    const writer = makeSettingsWriter(record)
    const inspected = await writer.inspectRecovery()

    expect(inspected).toMatchObject({
      kind: 'recoverable',
      invalidKeys: ['downloadConcurrency'],
      unknownKeys: ['futureSetting'],
    })
    expect(JSON.stringify(inspected)).not.toContain('opaque-token')

    await expect(writer.recover('repair', inspected.fingerprint)).resolves.toMatchObject({
      _tag: 'SettingsRecoveryStatus',
      kind: 'healthy',
    })
    expect(record.current()).toMatchObject({
      version: 1,
      revision: 1,
      settings: {
        downloadConcurrency: defaults.downloadConcurrency,
        cloudUploadEnabled: true,
        gdriveRefreshToken: 'opaque-token',
      },
    })
    expect((record.current() as { settings: Record<string, unknown> }).settings).not.toHaveProperty(
      'futureSetting',
    )
  })

  it('publishes only canonical commits, including confirmed repair and reset', async () => {
    const repairRecord = memoryRecord({ downloadConcurrency: 'fast', cloudSyncEnabled: true })
    const repairWriter = makeSettingsWriter(repairRecord, () => 'repaired-device')
    const repairCommits: Settings[] = []
    repairWriter.onCommit((settings) => repairCommits.push(settings))

    await repairWriter.update({ theme: 'dark' })
    expect(repairCommits).toEqual([])
    const repair = await repairWriter.inspectRecovery()
    await repairWriter.recover('repair', repair.fingerprint)
    expect(repairCommits).toEqual([
      expect.objectContaining({ cloudSyncEnabled: true, cloudDeviceId: 'repaired-device' }),
    ])

    const resetRecord = memoryRecord({ version: 99, revision: 1, settings: { future: true } })
    const resetWriter = makeSettingsWriter(resetRecord)
    const resetCommits: Settings[] = []
    resetWriter.onCommit((settings) => resetCommits.push(settings))
    const reset = await resetWriter.inspectRecovery()
    await resetWriter.recover('reset', reset.fingerprint)
    expect(resetCommits).toEqual([defaults])
  })

  it('rejects a stale recovery confirmation after another FIFO write', async () => {
    const record = memoryRecord({
      downloadConcurrency: 'fast',
      futureSetting: true,
    })
    const writer = makeSettingsWriter(record)
    const inspected = await writer.inspectRecovery()

    await writer.update({ theme: 'dark' })
    expect((await writer.inspectRecovery()).fingerprint).not.toBe(inspected.fingerprint)
    await expect(writer.recover('repair', inspected.fingerprint)).resolves.toEqual({
      _tag: 'SettingsRecoveryFailure',
      reason: 'stale-snapshot',
    })
  })

  it('resets blocked future data only after inspection', async () => {
    const record = memoryRecord({
      version: 99,
      revision: 4,
      settings: { future: true },
    })
    const writer = makeSettingsWriter(record)
    const inspected = await writer.inspectRecovery()
    expect(inspected.kind).toBe('blocked')

    await expect(writer.recover('reset', inspected.fingerprint)).resolves.toMatchObject({
      _tag: 'SettingsRecoveryStatus',
      kind: 'healthy',
      revision: 1,
    })
    expect(record.current()).toEqual({
      version: 1,
      revision: 1,
      settings: defaults,
    })
  })

  it('requires explicit repair for an exhausted revision', async () => {
    const record = memoryRecord({
      version: 1,
      revision: Number.MAX_SAFE_INTEGER,
      settings: {
        ...defaults,
        downloadStrategy: 'aria2',
        cloudUploadEnabled: true,
      },
    })
    const writer = makeSettingsWriter(record)
    const inspected = await writer.inspectRecovery()

    expect(inspected).toMatchObject({
      kind: 'recoverable',
      revision: Number.MAX_SAFE_INTEGER,
      invalidKeys: ['$envelope.revision'],
    })
    await expect(writer.update({ theme: 'dark' })).rejects.toMatchObject({
      name: 'SettingsRecoveryRequiredError',
    })
    expect(record.writes).toEqual([])

    await expect(writer.recover('repair', inspected.fingerprint)).resolves.toMatchObject({
      _tag: 'SettingsRecoveryStatus',
      kind: 'healthy',
      revision: 1,
    })
    expect(record.current()).toMatchObject({
      version: 1,
      revision: 1,
      settings: {
        downloadStrategy: 'aria2',
        cloudUploadEnabled: true,
      },
    })
  })

  it('cannot heal another invalid field while the revision is exhausted', async () => {
    const raw = {
      version: 1,
      revision: Number.MAX_SAFE_INTEGER,
      settings: {
        ...defaults,
        downloadConcurrency: 'fast',
      },
    }
    const record = memoryRecord(raw)
    const writer = makeSettingsWriter(record)

    await expect(writer.update({ downloadConcurrency: 4 })).rejects.toMatchObject({
      name: 'SettingsRecoveryRequiredError',
    })
    expect(record.current()).toEqual(raw)
    expect(record.writes).toEqual([])
  })

  it('keeps an opaque oversize fingerprint stable until the FIFO writes', async () => {
    const record = memoryRecord({
      secretValue: 'must-never-cross-status'.repeat(20_000),
    })
    let nonce = 0
    const writer = makeSettingsWriter(
      record,
      () => 'unused-device',
      () => `snapshot-${++nonce}`,
    )

    const first = await writer.inspectRecovery()
    const second = await writer.inspectRecovery()
    expect(first).toMatchObject({ kind: 'blocked', fingerprint: 'opaque:snapshot-1' })
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(JSON.stringify(first)).not.toContain('must-never-cross-status')

    const reset = await writer.recover('reset', first.fingerprint)
    expect(reset).toMatchObject({ _tag: 'SettingsRecoveryStatus', kind: 'healthy' })
    if (reset._tag !== 'SettingsRecoveryStatus') return
    expect(reset.fingerprint).not.toBe(first.fingerprint)
  })
})
