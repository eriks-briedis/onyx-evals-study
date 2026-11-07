# version-filter: answer a dated question from the versions in force on that date

An Onyx patch for corpora that hold several versions of the same document (here 9 Authorised
Versions of one Act, 4 of the Regulations, 1 of the Rooming House Standards). It makes Onyx's
own date step do what the perfect-filter arm does by hand: pick, per instrument, the version
in force on the question's date, before the model sees anything.

## What stock Onyx does

With `auto_detect_search_filters` on, the search tool asks the model one question per turn
(`onyx/secondary_llm_flows/time_filter.py`): which document dates does the conversation
restrict the search to? For "It is 1 October 2025. My landlord ..." the answer is either
`updated (None, None)` (haiku, 10 of 10 quick questions: no filter, every version is searched
and the answer mixes them) or a one-day window "updated on 2025-10-01" (luna, 6 of 16 cases:
nothing matches, the answer says the documents don't cover it).

## What the patch does

Two functions in `version_filter.py`, wired in by three one-line edits to
`onyx/tools/tool_implementations/search/search_tool.py`:

1. `decide_as_at_filter` replaces `decide_time_filter` in the per-turn job list. One LLM call
   on the arm's model: "what date should this be answered as at?" (`as_at (YYYY-MM-DD)` or
   `as_at (None)`). On haiku it returns the scenario date for 10 of 10 quick questions. When it
   returns None the question is answered as at today (a user who states no date means now),
   so every instrument's current version is searched. Only a failed as-at call falls back to
   the stock `decide_time_filter`. The prompt distinguishes a date the situation is judged at
   ("It is 1 October 2025"; "a notice given on 12 May 2020, was it valid?") from a date that
   only marks a step in a situation asked about now ("I sent the form three weeks ago"): the
   second is None, so it is answered as at today.
2. `apply_time_filter` replaces `TimeFilter.apply_to` where the inferred window meets the
   filters. For documents that carry in-force labels it restricts the search to the version of
   each instrument in force on the window's last day, via a `tags` filter (`version_id`).
   Unlabelled corpora get the stock updated-at window.
   A second selection rule, `latest-dated` (`apply.sh rule latest-dated`, read per search),
   ignores the in-force labels: for each title family (the file name without its version and
   date tokens) it takes the document with the latest file date (`doc_updated_at`) on or before
   the as-at date. That is what a deployment without hand-written labels could run, provided
   the file date is the version's own date and not the upload date. The filter still keys on
   the `version_id` tag because Onyx's filter model (source, document set, date ranges, tags)
   has no document-id filter; a deployment would set one tag per file from its name. On this
   corpus both rules pick the same versions on every scenario date and today.

The labels are the `onyx_metadata` tags in `corpus/manifest.yaml`, which `npm run seed` uploads as
each file's `.onyx_metadata.json`:

| tag | value | example |
|---|---|---|
| instrument | one per family of versions | rta-1997 |
| version_id | one per document | rta-1997-v110 |
| in_force_from | YYYY-MM-DD | 2025-08-06 |
| in_force_to | YYYY-MM-DD, absent while still in force | 2025-11-24 |

Seeding with the labels needs a fresh connector (`npm run seed` makes one when the metadata
changes), so the index must be rebuilt once.

## Install, check, remove

```
onyx-patches/version-filter/apply.sh apply     # copies the module in, edits search_tool.py, restarts api_server
onyx-patches/version-filter/apply.sh check     # exit 0 when in place; the eval hook runs this when manifest.json pins the patch
onyx-patches/version-filter/apply.sh revert    # restores search_tool.py.orig, removes the module, restarts
onyx-patches/version-filter/apply.sh rule labels|latest-dated   # the selection rule (default labels)
```

The patch lives in the container's filesystem only: recreating api_server drops it, and the
hook refuses to run while manifest.json's `onyx_api_server_patches` names it and `check` fails.

## What a run shows

api_server logs one line per search: `Internal search - as-at date: 2025-10-01` (or `none
stated; using today (<date>)`) and `Internal search - version filter: in force on
2025-10-01: rt-regs-2021-v004, rt-rooming-house-standards-regs-2023-v002, rta-1997-v110`.
`scripts/datefilter-log.py --since <iso> --until <iso>` counts them for a run.

## Turning it off

The container does not follow this repo: the patch stays applied until `apply.sh revert`, and
it acts on every run with auto filters on (`npm run filters -- on`). To measure stock Onyx,
revert it and drop the `onyx_api_server_patches` entry from `manifest/manifest.json`, or run
with auto filters off. Re-seeding is never needed: the in-force tags are on the documents
either way, and stock Onyx ignores them.

## Changes

- 4 Nov 2026: no date stated means today (before, the patch fell back to stock Onyx, which
  searches every version). The prompt stopped reading a past event's date ("three weeks ago")
  as the as-at date.
- 4 Nov 2026: the label-free `latest-dated` rule.
