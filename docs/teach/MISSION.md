# Mission: Monadic / functional design in TypeScript (via Effect)

## Why
**Master monadic and category-theoretic thinking in TypeScript** — to the point of fluency in
design and defence, not cargo-cult. Effect-TS and the x-media-downloader codebase are the
*vehicle/case study*, not the goal: code changes exist to make a concept concrete and runnable.
The payoff: read, design, and justify any functional-TS signature from first principles.

## Success looks like
- Explain `Option`/`Either`/Effect as functors and monads, and say precisely what the monad laws buy you.
- Recognise a "Kleisli arrow" in your own code and know when composing them is worth it (and when it is not).
- Justify "monad over `null` + `throw`" to a skeptical colleague using both theory and engineering evidence.
- Decide *where to stop* applying the pattern (the curation judgment you already exercised in Phase 4).

## Constraints
- Strong TypeScript/engineering background; comfortable with generics, discriminated unions, Effect 4 (beta.92).
- Prefers extremely concise communication. Learns from real examples in *this* codebase.
- Math background / appetite for formal rigor: TBD — calibrate in session 1.

## Out of scope (for now)
- Full Effect runtime (fibers, layers/services, scheduling) — separate future mission.
- Haskell syntax for its own sake; only used as a reference notation.
- Monad transformers, free monads, advanced CT (adjunctions beyond the Kleisli intuition).
