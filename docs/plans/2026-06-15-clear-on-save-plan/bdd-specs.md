# Clear-on-Save (Un-like) — BDD Specs

Source of truth for task scenarios. Derived from the design spec
([../../superpowers/specs/2026-06-15-clear-on-save-design.md](../../superpowers/specs/2026-06-15-clear-on-save-design.md)).

## Feature: Removal tracker (pure per-tweet tally) — task 001

```gherkin
Scenario: Single-media post fully saved emits remove
  Given a tweet "t1" armed with total 1
  When its 1 item confirms complete
  Then the tracker emits remove(t1) exactly once

Scenario: Multi-media post partially saved emits nothing
  Given a tweet "t1" armed with total 4
  When 3 of its items confirm complete
  Then the tracker emits no decision and "t1" stays pending

Scenario: Multi-media post fully saved emits remove exactly once
  Given a tweet "t1" armed with total 4
  When all 4 items confirm complete
  And a stray extra complete arrives afterward
  Then the tracker emits remove(t1) exactly once and never again

Scenario: Any failed item keeps the post
  Given a tweet "t1" armed with total 4
  When 3 items confirm complete and 1 item fails
  And the failure may arrive before or after the completions
  Then the tracker never emits remove(t1)

Scenario: Events for an un-armed tweet are ignored
  Given no tweet has been armed
  When a complete event arrives for "t_ghost"
  Then the tracker emits no decision and tracks nothing
```

## Feature: Settings schema — task 002

```gherkin
Scenario: autoUnlikeOnSave defaults to false and round-trips
  Given a settings object with no autoUnlikeOnSave key
  When it is decoded by the Settings schema
  Then autoUnlikeOnSave is false
  And encoding then decoding a settings object with autoUnlikeOnSave true preserves true
```

## Feature: Popup un-like toggle — task 003

```gherkin
Scenario: Settings panel shows an un-like toggle bound to the setting
  Given the popup settings panel is rendered with autoUnlikeOnSave false
  When the user toggles "Un-like after saving (Likes page)" on
  Then the persisted settings autoUnlikeOnSave becomes true
```

## Feature: X actions + likes-surface matcher — task 004

```gherkin
Scenario: Likes surface is recognized by path
  Given the page path "/animalfarmchina/likes"
  Then isLikesSurface returns true
  And for "/i/bookmarks" it returns false
  And for "/home" it returns false
  And for "/animalfarmchina" it returns false

Scenario: findLikeControl resolves the already-liked control by data-testid
  Given a tweet article fixture containing a child with data-testid "unlike"
  When findLikeControl is called with that article
  Then it returns the element with data-testid "unlike"
  And it does not rely on any aria-label text

Scenario: clearFromList clicks the unlike control for the matched tweet
  Given a document fixture with an article for tweet "t1" containing an unlike control
  When clearFromList("t1", { unlike: true }) is called
  Then the unlike control receives a click
  And when no article for "t1" is present it performs no click and reports not-found
```

## Feature: Background wiring + dedup — task 005

```gherkin
Scenario: Duplicate onChanged complete for one downloadId is counted once
  Given a tweet "t1" armed with total 2 and two downloadIds d1,d2 on tab 42
  When onChanged fires complete for d1 twice and complete for d2 once
  Then the tracker receives exactly one itemComplete per downloadId
  And exactly one clearFromList(t1) message is produced

Scenario: All items complete sends clearFromList to the originating tab
  Given a tweet "t1" downloaded from tab 42, total 1
  When its item confirms complete
  Then onChanged returns { type:'clearFromList', tweetId:'t1', unlike:true, tabId:42 }

Scenario: An interrupted item prevents clearFromList
  Given a tweet "t1" armed with total 2
  When one item completes and the other is interrupted (outcome 'failed')
  Then no clearFromList message is produced for t1
```

## Feature: Content-script wiring (manual / integration) — task 006

```gherkin
Scenario: Likes-page download arms the tracker and un-likes on completion
  Given the user is on their Likes page with autoUnlikeOnSave on
  When they download all media of a liked post and every item confirms complete
  Then the post is un-liked and disappears from the Likes list
  And if any item fails the post stays liked
```
