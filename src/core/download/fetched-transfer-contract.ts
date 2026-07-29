import { OFFSCREEN_BLOB_MAX_LEASE_BYTES } from '../offscreen-blob-protocol'

/** The narrow Fetched boundary. Strategy decides policy; the gateway owns bytes. */
export const MAX_FETCHED_BYTES = OFFSCREEN_BLOB_MAX_LEASE_BYTES

export interface ByteSource {
  readonly read: () => Promise<{
    readonly done: boolean
    readonly value?: Uint8Array
  }>
  readonly cancel: () => Promise<void>
}

/** Deferred byte ownership. Capacity is reserved before this may fetch or allocate. */
export interface FetchedBlobSource {
  readonly mimeType: string
  readonly body: ByteSource
}

/** Durable identity for the one browser handoff a Fetched lease may own. */
export type FetchedTransferOwner = {
  readonly tag: 'transfer'
  readonly requestId: string
  readonly projectionId: string
  readonly attempt: number
  readonly since: number
  readonly priorDownloadId?: number
}

/** Capture exports share Blob staging but never enter the transfer registry. */
export type FetchedCaptureOwner = {
  readonly tag: 'capture'
  readonly exportId: string
}
export type FetchedLegacyOwner = { readonly tag: 'legacy-unknown' }
export type FetchedLeaseOwner = FetchedTransferOwner | FetchedCaptureOwner | FetchedLegacyOwner

export type FetchedBootObservation =
  | {
      readonly tag: 'staging'
      readonly leaseId: string
      readonly owner: FetchedTransferOwner
    }
  | {
      readonly tag: 'matched'
      readonly leaseId: string
      readonly owner: FetchedTransferOwner
      readonly downloadId: number
      /** Exact Chrome observation at boot; terminal rows can release orphan leases. */
      readonly terminal: boolean
      /** Present for a terminal observation; preserves the durable outcome. */
      readonly terminalState?: 'complete' | 'interrupted'
    }
  | {
      readonly tag: 'unknown'
      readonly leaseId: string
      readonly reason:
        | 'no-url-match'
        | 'many-url-matches'
        | 'missing-id'
        | 'search-failed'
        | 'legacy-owner'
    }

/** Exact durable lease evidence for a terminal Chrome event before Registry bind. */
export type FetchedTerminalTransferObservation = Extract<
  FetchedBootObservation,
  { readonly tag: 'matched' }
>

export type FetchedBootInspection =
  | {
      readonly tag: 'available'
      readonly observations: ReadonlyArray<FetchedBootObservation>
    }
  | { readonly tag: 'unavailable'; readonly reason: string }

export interface FetchedTransferGateway {
  /** Persists an empty, pre-fetch capacity lease. It never opens a source. */
  readonly reserve: (
    owner: Exclude<FetchedLeaseOwner, FetchedLegacyOwner>,
  ) => Promise<
    | { readonly kind: 'reserved'; readonly leaseId: string }
    | { readonly kind: 'busy' }
    | { readonly kind: 'owner-duplicate' }
    | { readonly kind: 'unavailable' }
  >
  /**
   * Waits for durable capacity, then atomically reserves one Capture lease.
   * Use only after an earlier part started; initial pressure should stay visible.
   */
  readonly awaitCaptureReservation: (
    owner: FetchedCaptureOwner,
  ) => Promise<
    | { readonly kind: 'reserved'; readonly leaseId: string }
    | { readonly kind: 'owner-duplicate' }
    | { readonly kind: 'unavailable' }
  >
  /** Uses one exact earlier reservation. It never reserves another lease. */
  readonly startReserved: (input: {
    readonly leaseId: string
    readonly owner: Exclude<FetchedLeaseOwner, FetchedLegacyOwner>
    readonly filename: string
    readonly open: (signal?: AbortSignal) => Promise<FetchedBlobSource>
  }) => Promise<
    | { readonly kind: 'started'; readonly downloadId: number }
    | { readonly kind: 'too-large' }
    | { readonly kind: 'owner-duplicate' }
    | { readonly kind: 'unavailable' }
    | { readonly kind: 'handoff-ambiguous' }
  >
  readonly start: (input: {
    readonly owner: Exclude<FetchedLeaseOwner, FetchedLegacyOwner>
    readonly filename: string
    /** The gateway aborts stalled fetches before they can hold a durable lease forever. */
    readonly open: (signal?: AbortSignal) => Promise<FetchedBlobSource>
  }) => Promise<
    | { readonly kind: 'started'; readonly downloadId: number }
    | { readonly kind: 'too-large' }
    /** Durable capacity is full. No response source was opened. */
    | { readonly kind: 'busy' }
    | { readonly kind: 'owner-duplicate' }
    | { readonly kind: 'unavailable' }
    /** Chrome may have accepted after the durable ready checkpoint. Never retry it. */
    | { readonly kind: 'handoff-ambiguous' }
  >
  readonly releaseTerminal: (downloadId: number) => Promise<void>
  /** Inspects transfer rows without releasing them. It never throws. */
  readonly inspectOnBoot: () => Promise<FetchedBootInspection>
  /** Finds, but never releases, an exact transfer lease for a terminal Chrome id. */
  readonly observeTerminalTransfer: (
    downloadId: number,
  ) => Promise<FetchedTerminalTransferObservation | undefined>
  /** Cleans only Capture-owned terminal leases. Safe before registry readiness. */
  readonly releaseCaptureTerminal: (downloadId: number) => Promise<void>
  /** Releases terminal evidence the Registry has proved unowned or superseded. */
  readonly releaseAutonomousTerminal: (downloadId: number) => Promise<void>
  /** Alarm wake for terminal Capture/unowned cleanup retained after a failed revoke. */
  readonly retryAutonomousTerminalCleanup: () => Promise<void>
  /** Staging is proven pre-Chrome; only a registry recovery acknowledgement may remove it. */
  readonly discardRecoveredStaging: (leaseIds: ReadonlyArray<string>) => Promise<void>
}
