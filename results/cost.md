# What the study cost

Per answer means one eval question through Onyx: query rewrites, the section-picking step, the relevance checks and the answer itself, all on the arm's model. Onyx records these per model and stage; answers per arm come from the saved results. Prices are API list prices checked 5 Nov 2026 (Claude Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50; GPT-5.6 Luna $0.20/$1.20, Sol $5/$30 per million input/output tokens). Local models cost electricity only.

## Tokens and cost per answer, by arm

| arm | model | answers | input tokens per answer | output per answer | of which the answer step | section picking | relevance checks | cost per answer |
|---|---|---|---|---|---|---|---|---|
| haiku | claude-haiku-5-5 | 550 | 183,603 | 11,241 | 36% | 33% | 30% | $0.024 |
| sonnet | claude-sonnet-5-5 | 120 | 164,039 | 5,167 | 43% | 26% | 30% | $0.380 |
| opus | claude-opus-5-5 | 90 | 171,711 | 4,134 | 46% | 24% | 29% | $0.770 |
| luna | gpt-5.6-luna | 462 | 106,059 | 2,555 | 36% | 42% | 21% | $0.024 |
| sol | gpt-5.6-sol | 100 | 156,589 | 1,588 | 49% | 33% | 18% | $0.831 |
| qwen | qwen3.6:35b | 398 | 41,963 | 10,029 | 64% | 17% | 16% | $0 (local) |

Note: the answer counts include every run of the arm (both filter settings, the perfect-filter arm, repeats and variants), so the per-answer figures are averages over all of them.

## The judge

- claude-opus-5-5 grades three rubrics per answer. Measured over 1,594 Opus-judged answers: 6,413 input and 1,011 output tokens per answer, about $0.046 per answer at list price.
- One full setup (16 cases) costs about $0.73 to judge; the 3-run matrix of 6 setups about $13.22.
- Earlier judges (gpt-6-astra, Sonnet) read the same prompts; switching every arm to Opus roughly doubled the judge cost per answer and was worth it: in the blind hand-check it agreed with the human label on 103 of 105 verdicts (results/hand-check/).

## What a 3-run experiment costs (10 quick cases, 3 runs = 30 answers)

| arm | answers | judging | total |
|---|---|---|---|
| haiku | $0.72 | $1.38 | $2.10 |
| sonnet | $11.39 | $1.38 | $12.77 |
| opus | $23.09 | $1.38 | $24.46 |
| luna | $0.73 | $1.38 | $2.11 |
| sol | $24.92 | $1.38 | $26.29 |
| qwen | $0.00 (local) | $1.38 | $1.38 |

## Contextual retrieval indexing (one-off)

- 26 documents, 10,068 chunks: 11,408 calls to qwen3:4b-instruct on local Ollama, 10.7M prompt tokens plus about 0.6M output, 2.25 GPU hours on a 16 GB card.
- The same calls at API prices: about $1 on Haiku 5.5, $27 on Sonnet 5.5.
- Every re-index with contextual retrieval on repeats this; every new version of an Act adds about 650 chunk calls.
