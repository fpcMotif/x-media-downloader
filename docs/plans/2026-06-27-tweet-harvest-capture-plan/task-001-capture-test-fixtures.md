# Task 001: Create capture test fixtures

**depends-on**: <!-- none — independent -->

## Description
Create three realistic GraphQL JSON fixtures under `src/test/fixtures/` that mirror the real X GraphQL response shapes the capture feature must parse, derived/trimmed from the gitignored reference copy at `study/TwitterMediaHarvest/src/libs/XApi/parsers/test-data`. These fixtures give the gated `src/core/capture/**` tests (record extraction, link de-shortening, card parsing, tree building) real-world data to exercise — a genuine multi-level reply chain inside a `threaded_conversation_with_injections_v2`, `t.co`/`expanded_url` link entities, and both the flat-summary and `unified_card` card encodings. This is a data/fixtures task: it produces JSON only, with no code logic, and unblocks the downstream Red tasks that load these files.

## Execution Context
**Task Number**: 001 of 30
**Phase**: Setup
**Prerequisites**: None — this is the first task and is independent of all others. Read-access to the gitignored reference data at `study/TwitterMediaHarvest/src/libs/XApi/parsers/test-data` (`TweetDetail.json`, `UserTweets.json`, `UserMedia.json`) is assumed available locally; if absent, hand-author the fixtures to the same shapes described in spec §6.0–§6.3.

## BDD Scenario
```gherkin
Scenario: Realistic GraphQL fixtures exist for capture tests
  Given the gitignored reference copy at study/TwitterMediaHarvest/src/libs/XApi/parsers/test-data
  When I derive trimmed fixtures into src/test/fixtures
  Then tweet-detail-thread.json contains a real threaded_conversation_with_injections_v2 with a multi-level reply chain (root -> reply A -> reply-to-A B) authored inside conversationthread items[] modules
  And tweet-with-links.json contains legacy.entities.urls[] with t.co + expanded_url (incl. a youtube and an arxiv link)
  And tweet-with-card.json contains BOTH a flat summary card and a unified_card binding_values shape
  And every fixture parses as valid JSON
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§13)

## Files to Modify/Create
- Create: `src/test/fixtures/tweet-detail-thread.json`
- Create: `src/test/fixtures/tweet-with-links.json`
- Create: `src/test/fixtures/tweet-with-card.json`

## Contracts (signatures/types ONLY — no bodies)
```ts
// JSON fixtures only — shapes mirror real X GraphQL (see spec §6.0–§6.3).
// tweet node: data...result { rest_id, core.user_results.result.{rest_id,legacy.{screen_name,name}}, legacy.{full_text,conversation_id_str,in_reply_to_status_id_str,created_at,lang,*_count,entities.{urls,user_mentions,hashtags},extended_entities.media}, views.count, card.legacy.binding_values, quoted_status_result }
```

## Steps
1. Verify the scenario intent against spec §13 (the "New fixtures" paragraph) and §6.0–§6.3 (the verified JSON paths each fixture must carry). Confirm the three target file names and the required sub-shapes (multi-level reply chain; `t.co` + `expanded_url`; flat card + `unified_card`).
   - Verification: re-read spec lines around §13 and the §6.1 field table; note that `tweet-detail-thread.json` must nest its reply chain inside `conversationthread` `items[]` modules (not flat children), and that reply parentage is carried by `legacy.in_reply_to_status_id_str`.
2. Inspect the reference data to source realistic shapes: read the gitignored `study/TwitterMediaHarvest/src/libs/XApi/parsers/test-data/TweetDetail.json` (for the `threaded_conversation_with_injections_v2` / `conversationthread` module shape and card encodings) and `UserTweets.json`/`UserMedia.json` (for `legacy.entities.urls[]`, `extended_entities.media`, and `views.count`). Trim aggressively — keep only the nodes and fields the §6.1 table references.
   - Verification: `ls study/TwitterMediaHarvest/src/libs/XApi/parsers/test-data` lists `TweetDetail.json`, `UserTweets.json`, `UserMedia.json`; the relevant `threaded_conversation_with_injections_v2`, `binding_values`, and `urls` keys are present in the source.
3. Author `src/test/fixtures/tweet-detail-thread.json`: a real `threaded_conversation_with_injections_v2` containing a genuine three-tweet chain — a root tweet, reply A whose `legacy.in_reply_to_status_id_str` is the root's id, and reply B whose `legacy.in_reply_to_status_id_str` is reply A's id (B is a grandchild of root) — with each tweet authored inside `conversationthread` `items[]` module entries. Each tweet result carries `rest_id`, `core.user_results.result.{rest_id,legacy.{screen_name,name}}`, and `legacy.{full_text,conversation_id_str,in_reply_to_status_id_str,created_at,lang,*_count}`.
   - Verification: the file contains exactly one `threaded_conversation_with_injections_v2`; three distinct `rest_id` values appear; B's `in_reply_to_status_id_str` equals A's `rest_id` and A's equals the root's `rest_id`; tweets sit inside `conversationthread` `items[]` modules.
4. Author `src/test/fixtures/tweet-with-links.json`: a tweet node whose `legacy.entities.urls[]` contains multiple entries, each with `url` (a `t.co` short link), `expanded_url` (the real destination), `display_url`, and code-unit `indices` — including at least one YouTube link and one arXiv link — plus a matching `legacy.full_text` that embeds those `t.co` tokens at the given offsets.
   - Verification: `legacy.entities.urls[]` has at least two entries; one `expanded_url` contains `youtube`/`youtu.be` and one contains `arxiv.org`; each entry has both `url` (t.co) and `expanded_url`; `full_text` contains the `t.co` tokens.
5. Author `src/test/fixtures/tweet-with-card.json`: include BOTH card encodings described in §6.3 — a flat `summary`/`summary_large_image` card under `card.legacy.binding_values[]` keyed `title`/`description`/`domain`/`card_url`, AND a `unified_card` whose `binding_values` carries a JSON-encoded `string_value` (the unified-card blob with `component_objects`/`destination_objects`). Carry enough surrounding tweet shape (`rest_id`, `legacy.full_text`, `legacy.entities.urls[]`) for the card-join tests to anchor on.
   - Verification: the file contains a flat `binding_values` array with `title`/`description`/`domain` keys AND a `unified_card` binding whose `string_value` is a JSON-encoded string; both are present in one file.
6. Confirm all three files are syntactically valid JSON and committed to the fixtures directory.
   - Verification: run the JSON-parse command in Verification Commands; it prints `fixtures OK` with no parse error.

## Verification Commands
```bash
node -e "for (const f of ['tweet-detail-thread','tweet-with-links','tweet-with-card']) JSON.parse(require('fs').readFileSync('src/test/fixtures/'+f+'.json','utf8')); console.log('fixtures OK')"
```

## Success Criteria
- All three files exist at the exact paths under `src/test/fixtures/` and each parses as valid JSON (the verification command prints `fixtures OK`).
- `tweet-detail-thread.json` contains one real `threaded_conversation_with_injections_v2` with a multi-level reply chain (root → reply A → reply-to-A B, B a grandchild of root) authored inside `conversationthread` `items[]` modules, with reply parentage carried by `legacy.in_reply_to_status_id_str`.
- `tweet-with-links.json` contains `legacy.entities.urls[]` entries each with a `t.co` `url` and an `expanded_url`, including a YouTube link and an arXiv link, with matching `legacy.full_text`.
- `tweet-with-card.json` contains BOTH a flat summary card (`card.legacy.binding_values[]` keyed `title`/`description`/`domain`/`card_url`) and a `unified_card` (`binding_values` with a JSON-encoded `string_value` blob).
- Shapes mirror real X GraphQL per spec §6.0–§6.3 (no invented fields beyond the contract); this is a fixtures-only task (no source code, no unit gate) — verification is the JSON-parse command above. The downstream gated `record.test.ts`, `card.test.ts`, and `tree.test.ts` tasks can load these fixtures unchanged.
