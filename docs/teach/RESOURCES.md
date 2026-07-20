# Monadic / functional TypeScript Resources

## Knowledge

- [Bartosz Milewski — "Kleisli Categories"](https://bartoszmilewski.com/2014/12/23/kleisli-categories/)
  The single best on-ramp: builds the Maybe/Option monad *from the problem of composing partial functions*. **Primary source for Lesson 1.** Use for: the Kleisli intuition, the fish operator, "a monad is a way of composing embellished functions."
- [Bartosz Milewski — "Monads: Programmer's Definition"](https://bartoszmilewski.com/2016/11/21/monads-programmers-definition/) and [Category Theory for Programmers (full, free)](https://bartoszmilewski.com/2014/10/28/category-theory-for-programmers-the-preface/)
  The three equivalent monad definitions (bind / join+unit / Kleisli). Use for: functor laws, monad laws, η and μ.
- [nLab — "Kleisli category"](https://ncatlab.org/nlab/show/Kleisli+category) and [nLab — "maybe monad"](https://ncatlab.org/nlab/show/maybe+monad)
  The rigorous definitions (`Kl(T)(X,Y) := C(X, T Y)`, composition `μ ∘ T(g) ∘ f`). Maybe's Kleisli category = the category of **partial maps**. Use for: precise statements, the adjunction story.
- [Scott Wlaschin — "Railway Oriented Programming"](https://fsharpforfunandprofit.com/rop/) (+ his [follow-up cautioning against overuse](https://fsharpforfunandprofit.com/posts/against-railway-oriented-programming/))
  The visual model for `Either`/`Result` and the *when-not-to* wisdom — directly mirrors your Phase 4 curation. Use for: justification, short-circuiting, "don't reinvent exceptions."
- [Tony Hoare — "Null References: The Billion-Dollar Mistake" (QCon 2009, InfoQ)](https://www.infoq.com/presentations/Null-References-The-Billion-Dollar-Mistake-Tony-Hoare/)
  The canonical argument against `null`; he knew disjoint unions (sum types) were the right answer in 1965. Use for: the "why not null" half of the justification.
- [Effect docs — Option](https://effect.website/docs/data-types/option/) and [Either](https://effect.website/docs/data-types/either/)
  The exact API you're using (`some`/`none`/`flatMap`/`getOrElse`/`fromUndefinedOr`). Use for: mapping theory → the functions in your repo. (Verify API names against installed effect 4.0.0-beta.92.)

## Wisdom (Communities)
- [r/functionalprogramming](https://reddit.com/r/functionalprogramming) — language-agnostic, theory-friendly. Use for: design-rationale debates, "is this over-engineered?" critique.
- [Effect Discord](https://discord.gg/effect-ts) — the maintainers + practitioners. Use for: idiomatic Effect, Option/Either patterns, real review.
- [Lobsters](https://lobste.rs) (`functional` tag) — high-signal practitioner discussion. Use for: testing a justification argument against skeptics.

## Gaps
- No source yet that maps Effect's *three-channel* `Effect<A, E, R>` to its categorical structure (relevant once the mission expands beyond Option/Either). Find before teaching the runtime.
