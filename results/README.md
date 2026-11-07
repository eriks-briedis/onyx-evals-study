# Results

Every number in the write-up comes from a file here. Start with [summary.md](summary.md).

"Filters" or "date step" in these files means one of four things. Check which one before
comparing two tables:

| label | what Onyx did with the question's date |
|---|---|
| off | nothing: every version of every law was searched |
| on, stock | Onyx's own date filter (`auto_detect_search_filters`), unpatched |
| on, patch | the [version-filter patch](../onyx-patches/version-filter/): search only the versions in force on the question's date |
| asof | the perfect filter: a document set holding only the versions in force that day, built by hand |

In the raw files and CSVs the column is just `on`. It means the patch in the `datefilter*`,
`latest-dated`, `undated*` and `heldout*` setups, and stock Onyx everywhere else.

## Files

| file | what | made by | needs |
|---|---|---|---|
| [summary.md](summary.md) | cases passed per run, every setup | `scripts/summarise-answers.py` | this repo only |
| [setups.md](setups.md) | every setup, what changed in it, and how many runs and answers | `scripts/export-answers.py` | raw runs |
| [answers/](answers/) | every judged answer, one JSON line each: question, answer, documents fed, each judge's verdict and reason | `scripts/export-answers.py` | raw runs |
| [repeat-summary.md](repeat-summary.md) | the baseline matrix over 3 runs, and how stable each case is | `scripts/repeat-summary.py` | raw runs |
| [heldout-summary.md](heldout-summary.md) | the held-out set: stock search against the patch | `scripts/heldout-summary.py` | raw runs |
| [filters-comparison.md](filters-comparison.md) | run 1 of the baseline only, per case, with the date filter Onyx inferred for each answer | `scripts/compare-filter-runs.py` | raw runs, Langfuse ClickHouse |
| [query-dates.md](query-dates.md) | whether the question's date reached the search queries | `scripts/query-dates.py` | raw runs, Langfuse ClickHouse |
| [dropped-points.md](dropped-points.md) and `dropped-points-<setup>.md` | which required points answers left out, and whether the law passage for each had reached the model; per-answer and per-point CSVs in the folder of the same name | `scripts/dropped-points.py` | raw runs, live Onyx, the judge endpoint |
| [cost.md](cost.md) | tokens and dollars per answer, per model, and for the judge | `scripts/usage-cost.py` | raw runs, Onyx's database |
| [hand-check/](hand-check/) | the blind check of the judge: answers labelled by hand without seeing its verdicts (`sheet*.md`), and the agreement (`score*.md`) | `scripts/hand-check.py` | raw runs |

The dropped-points reports cover the models that had run when each was made, so a few cover
fewer models than [setups.md](setups.md) lists for the same setup. Their header says which.

## The hand-check

Batch 1 (`sheet.md`, `score.md`): 60 verdicts, the judge agreed with the hand label on 59. The
judge's rules were revised on this batch, so it is not an independent test. Batch 2
(`sheet2.md`, `score2.md`): 45 new verdicts after the revision, 44 agreed.

## Raw runs

The promptfoo output each summary was computed from (about 1.3 GB with search results and
telemetry) is not in the repo. [answers/](answers/) keeps what is needed to check a number. The
layout the scripts expect when you produce your own runs is in
[docs/reproduce.md](../docs/reproduce.md).
