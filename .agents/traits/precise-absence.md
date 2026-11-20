---
name: precise-absence
subject: Type annotations that include null or undefined.
requirement: >
  A function signature, exported type, or state type must not use `| null` or
  `| undefined` to mean "no value". It states what absence means: an Effect
  Option for a value that may be missing, a `_tag` union when there are
  distinct reasons or phases, or a named string-literal member such as 'none'
  or 'unknown'.
purpose: Make every reader handle each case by name instead of guessing what null means.
applicability: >
  First-party TypeScript under src. Does not apply to the line that receives a
  value from a DOM API, a browser.* extension API, or decoded backend JSON,
  provided the value is converted before it leaves that function.
guidance: >
  Convert at the boundary with an explicit check. Schema.NullOr is correct for
  a wire format that carries JSON null. Do not convert an Option back with
  Option.getOrNull or Option.getOrUndefined just to pass it on.
---

## Violates

    const [granted, setGranted] = useState<boolean | null>(null)

    export function sizeReason(sizeBytes: number | null, maxFileSizeBytes: number): SkipReason | null

## Satisfies

    type OriginGrant =
      'no-origin' | 'checking' | 'granted' | 'denied' | 'check-failed' | 'request-failed'

    export function sizeReason(
      sizeBytes: Option.Option<number>,
      maxFileSizeBytes: number,
    ): Option.Option<SkipReason>
