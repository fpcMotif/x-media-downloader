# Durable Completion Ledger

`ledger.ts` owns the logical codec and pure transitions. IndexedDB `xmd-clear`
owns physical persistence. The coordinator owns CAS turns, browser
reconciliation, Worklist projection, and Clear sends.

An entry is truly complete only when every expected request is done, none failed,
and none remains in progress. A Clear is first reserved, then attempted. An
`attempted` Clear stays terminal until explicit recovery; a missing destructive
reply must never trigger a retry.

Scope intent is split into manual, automatic, and cross-list automatic scopes.
The entry records that intent at seed time and rechecks live policy before send.
Tombstones prevent a resolved scope from being re-seeded.
