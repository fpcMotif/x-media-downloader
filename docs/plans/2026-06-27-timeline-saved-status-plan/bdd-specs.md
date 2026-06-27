# BDD specs — Timeline "Saved" status from Convex

Derived from `docs/superpowers/specs/2026-06-27-timeline-saved-status-design.md`
(approach **B+C**). Source of truth for the task scenarios. Each scenario maps to a
test task (Red) paired with an implementation task (Green).

## Feature 1 — Backend: `media_state.tweetId` populated at write

```gherkin
Scenario: Queued event populates top-level tweetId
  Given a queued sync event whose media.tweetId is "T1"
  When recordEvents ingests it
  Then the created media_state row has a top-level tweetId equal to "T1"
  And the row is retrievable via the by_tweet index for "T1"

Scenario: Outcome event preserves tweetId
  Given an existing media_state row for request "R" with tweetId "T1"
  When a completed event for "R" (carrying no media) is ingested
  Then the row's tweetId remains "T1"
  And the row's lastKind is "completed"
```

## Feature 2 — Backend: `downloadedAmong` query (+ `backfillTweetId`)

```gherkin
Scenario: Returns only tweetIds with a completed row
  Given media_state has T1=completed, T2=queued, T3=failed
  When downloadedAmong is called with the correct secret and [T1, T2, T3, T4]
  Then it returns exactly [T1]

Scenario: Cross-device match (no device filter)
  Given T5 has a completed media_state row on device "A" only
  When downloadedAmong is called (from any device context) with [T5]
  Then it returns [T5]

Scenario: Fail-closed secret gate
  Given the deployment has SYNC_SHARED_SECRET configured
  When downloadedAmong is called with a wrong secret
  Then it throws an unauthorized error and reads nothing

Scenario: Oversized batch is rejected
  Given a tweetIds array longer than the cap (128)
  When downloadedAmong is called
  Then it throws a "batch too large" error

Scenario: Backfill fills missing tweetId from nested media
  Given a pre-existing media_state row with no top-level tweetId but media.tweetId "T6"
  When backfillTweetId runs
  Then that row gains a top-level tweetId equal to "T6"
```

## Feature 3 — Client: `ConvexPort.query` + `queryDownloadedAmong`

```gherkin
Scenario: Successful query returns the value
  Given the deployment answers 200 {status:'success', value:["T1"]}
  When port.query("sync:downloadedAmong", args) is called
  Then it resolves to ["T1"]

Scenario: Non-2xx maps to ConvexHttpError
  Given the edge answers HTTP 500
  When port.query is called
  Then it throws ConvexHttpError with status 500

Scenario: Function error maps to ConvexFunctionError
  Given the deployment answers 200 {status:'error', errorMessage:"unauthorized…"}
  When port.query is called
  Then it throws ConvexFunctionError carrying that message

Scenario: Non-Convex 200 maps to ConvexMalformedError
  Given a 200 whose body is an HTML page
  When port.query is called
  Then it throws ConvexMalformedError

Scenario: queryDownloadedAmong shapes the call
  Given a mock ConvexPort whose query resolves ["T1"]
  When queryDownloadedAmong(port, secret, ["T1","T2"]) is called
  Then it invokes path "sync:downloadedAmong" with { secret, tweetIds:["T1","T2"] }
  And resolves to ["T1"]
```

## Feature 4 — Core: `SavedIndex` (local-first merge)

```gherkin
Scenario: Seed answers from local history without querying Convex
  Given the index is seeded with ["T1","T2"]
  When resolve(["T1","T3"], queryConvex) runs and queryConvex(["T3"]) returns []
  Then the result contains "T1" and not "T3"
  And queryConvex was called only with the unknowns ["T3"]

Scenario: markSaved lights up instantly
  Given markSaved("T9") was called
  When resolve(["T9"], queryConvex) runs
  Then the result contains "T9" and queryConvex was not called

Scenario: Convex result is unioned and cached
  Given an empty seed
  When resolve(["T4"], queryConvex) runs and queryConvex returns ["T4"]
  Then the result contains "T4"
  And a second resolve(["T4"]) returns "T4" without re-querying

Scenario: Offline degrades to local-only, never throws
  Given the index is seeded with ["T1"]
  When resolve(["T1","T2"], queryConvex) runs and queryConvex rejects
  Then the result is ["T1"] and no error propagates

Scenario: A miss is not re-queried within the TTL
  Given resolve(["T5"]) ran and queryConvex returned [] (a miss)
  When resolve(["T5"]) runs again within the TTL window
  Then queryConvex is not called again
```

## Feature 5 — Schema: messages + `showSavedStatus` setting

```gherkin
Scenario: SavedStatusRequest/Response round-trip
  Given a SavedStatusRequest carrying tweetIds ["T1","T2"]
  Then it decodes successfully
  And a SavedStatusResponse carrying saved ["T1"] decodes successfully

Scenario: showSavedStatus defaults on
  Given the default Settings
  Then showSavedStatus is true
```

## Feature 6 — Background: seed + markSaved + request handler

```gherkin
Scenario: Handler resolves via SavedIndex
  Given a background with a SavedIndex seeded with ["T1"]
  When a SavedStatusRequest({ tweetIds:["T1","T2"] }) message arrives and queryConvex returns []
  Then it replies SavedStatusResponse({ saved:["T1"] })

Scenario: A local completion marks the index
  Given the background download pipeline
  When a download for tweetId "T7" reaches completed
  Then SavedIndex.markSaved("T7") is invoked

Scenario: Sync-off runs C-only
  Given Convex sync is not configured
  When a SavedStatusRequest arrives
  Then resolve runs with a no-op queryConvex (returns []) and answers from local history only
```

## Feature 7 — Overlay: sweep + render the "Saved ✓" chip

```gherkin
Scenario: A saved post gets one chip
  Given a timeline with articles for T1 and T2, and the background replies saved:["T1"]
  When the status sweep runs
  Then T1's article carries exactly one "Saved ✓" chip
  And T2's article carries none

Scenario: Injection is idempotent
  Given T1's article already carries a chip
  When the sweep runs again
  Then T1's article still carries exactly one chip

Scenario: Out-of-scope pages are skipped
  Given the current page is a profile (not For You / Following / List)
  When the overlay mounts
  Then no sweep runs and no chip is injected

Scenario: No data means no chip (fail-safe)
  Given the background replies saved:[]
  When the sweep runs
  Then no article is marked
```

## Feature 8 — Settings: `showSavedStatus` toggle

```gherkin
Scenario: Toggle off disables the feature
  Given showSavedStatus is false
  When the overlay mounts on an in-scope timeline
  Then no sweep runs and no chip appears

Scenario: Toggle persists and propagates
  Given the user flips showSavedStatus in the options page
  Then the setting is persisted
  And the overlay observes the new value
```
