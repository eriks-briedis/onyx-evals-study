# Onyx evals study: which version of the law does the answer use?

An evaluation of [Onyx](https://github.com/onyx-dot-app/onyx), a self-hosted RAG assistant,
answering renters' questions about Victorian (Australian) rental law, and a fix for what it
found.

The library holds 9 versions of the Residential Tenancies Act and 4 of its Regulations, as real
document libraries do. A question is set on a date ("It is 1 October 2025. ..."), and a correct
answer has to use the law in force that day. Every answer is graded on three checks against a
written gold answer: it states the required points, it says nothing on the "must not say" list,
and it names the documents in the version in force on the date. A case passes ("gold pass")
when retrieval finds the right documents and all three checks pass. Every setup ran 3 times.

Not legal advice: see [NOTICE](NOTICE).

## What it found

Numbers are cases passed out of 10 (the quick cases) or as stated, mean of 3 runs. All of them
are in [results/summary.md](results/summary.md), which anyone can rebuild from the published
answers.

1. **Stock Onyx mixes versions.** Searching every version, haiku passes 3.7 of 10 and names the
   right version in 5.3 ([repeat-summary.md](results/repeat-summary.md)). Onyx's own date filter
   does not help: it either sets no filter or a one-day window that matches nothing.
2. **Showing only the right version doubles the pass rate.** With a hand-built set of the
   versions in force on the date (the perfect filter), haiku goes to 7.3, luna 3.0 → 6.7,
   qwen 1.0 → 3.0, and the right version is named in almost every answer.
3. **The usual fixes do not get there.** A longer reading list (2.0), a stricter prompt (3.7),
   version labels on every chunk (3.7) and contextual retrieval (1.3) all leave haiku at or
   below where it started. A bigger model of the same family does not either (Sonnet 3.7,
   Opus 4.3).
4. **A small patch to Onyx does.** [onyx-patches/version-filter](onyx-patches/version-filter/)
   asks the model one question, "answered as at what date?", and searches only the versions in
   force that day. haiku 6.7, luna 5.3, Sonnet 9.0, Opus 9.0 of 10, and version-cited passes in
   26 to 30 of 30 answers per model. With no date in the question it answers as at today: haiku
   passes 6 of 6 undated cases in every run, against 1.0 without it.
5. **It holds on questions it never saw.** On 8 held-out questions (10 slots) written after the
   patch was frozen: haiku 0.7 → 3.7, luna 1.0 → 5.3, Sonnet 0.7 → 7.7
   ([heldout-summary.md](results/heldout-summary.md)).
6. **What is left is the writing.** Given the gold's own law passages and no search at all,
   haiku passes 7.0 and Opus 9.7 of 10 ([oracle](results/summary.md#oracle)). The
   [dropped-points reports](results/README.md#files) trace each missed point to whether its
   passage reached the model.

## Find your way

| folder | what |
|---|---|
| [questions/](questions/) | the 18 questions, one folder each: the gold for every date it is asked on, and the law it rests on |
| [results/](results/) | every summary, every judged answer, and how each was made |
| [docs/method.md](docs/method.md) | how the study was run: pipeline, prompts, judge, every setup |
| [docs/reproduce.md](docs/reproduce.md) | how to check the numbers, or run it yourself |
| [docs/glossary.md](docs/glossary.md) | the terms used here |
| [onyx-patches/version-filter/](onyx-patches/version-filter/) | the fix |
| [corpus/](corpus/) | the 14 law PDFs: where they come from and their checksums (the PDFs are downloaded, not stored) |
| [cases/](cases/), [datasets/](datasets/) | the questions compiled into eval cases (generated) |
| [src/](src/), [tests/](tests/) | the promptfoo harness: the Onyx provider, setup checks, asserts, case compiler |
| [scripts/](scripts/) | corpus download, case building, analysis |
| [manifest/manifest.json](manifest/manifest.json) | the pinned Onyx commit, settings, models and prompts every run checks itself against |

## Quick start

Check the published numbers (Python 3 with PyYAML):

```
python3 scripts/summarise-answers.py      # rebuilds results/summary.md from results/answers/
```

Build the cases from the questions (also needs `pdftotext`):

```
python3 scripts/fetch-corpus.py           # downloads the 14 PDFs and checks them
npm ci && npm test                        # offline tests
npm run cases                             # questions/ -> cases/ -> datasets/
npm run passages                          # the law passages in full, locally, in build/passages/
```

Running the evals needs a self-hosted Onyx, model API access and a judge endpoint:
[docs/reproduce.md](docs/reproduce.md).

## Licence

Code: MIT ([LICENSE](LICENSE)). Questions, gold, results and docs: CC BY 4.0. The Victorian
legislation is © State of Victoria and is not included ([NOTICE](NOTICE)).
