# Method

How every answer in this repo was produced and judged. For the steps to run it yourself, see [reproduce.md](reproduce.md). For terms, see [glossary.md](glossary.md).

## What is measured

Onyx is a self-hosted RAG assistant. The study asks it Victorian (Australia) rental-law questions. Its library holds several versions of the same Act and Regulations. A correct answer must use the version in force on the date the question is set.

Each answer gets four checks:

- **retrieval** (deterministic): every expected document (the versions in force on the question's date) is among the documents the search returned. See [src/asserts/retrieval.ts](../src/asserts/retrieval.ts).
- **must-mention** (judge): the answer states every required point in the gold.
- **must-not-say** (judge): the answer asserts nothing on the gold's must-not-say list. Raising a point only to reject it is fine.
- **version-cited** (judge): the answer names each must-cite document with its version, and every rule it applies comes from the version in force on that date. Applying another version's rule fails, even with a caveat. On the two dates whose in-force Act (v088) also prints the 2018 reforms under "Amendments Not in Operation", the rubric names them and says that applying them fails ([scripts/make-rental-cases.py](../scripts/make-rental-cases.py) `NOT_IN_OPERATION`).

**Gold pass** = retrieval passes AND must-mention, must-not-say and version-cited all pass.

The rubric text is in [src/rubrics.ts](../src/rubrics.ts). Each rubric is one Yes/No question with a one-sentence reason.

The run also records other checks (no error, the search tool was called, every citation points at a retrieved document, the answer contains a version token). They are not part of gold pass.

Every setup ran 3 independent times unless [results/setups.md](../results/setups.md) says otherwise. Results are means over the runs.

## Harness

- promptfoo (^0.122.2) sends each question to Onyx's `/api/chat/send-chat-message` as a new chat. Configs: [promptfooconfig.rentals.yaml](../promptfooconfig.rentals.yaml), [promptfooconfig.rentals-asof.yaml](../promptfooconfig.rentals-asof.yaml), [promptfooconfig.rentals-oracle.yaml](../promptfooconfig.rentals-oracle.yaml).
- Each request names a persona and a model override (`model_configuration_id`, temperature 0). Requests do not retry (`maxRetries: 0`). The search is limited to the document set `vic-rentals-baseline` unless a setup says otherwise.
- A provider label is `<persona>:<model>`, for example `rentals-v2:haiku`. A setup hook ([src/setup.ts](../src/setup.ts)) resolves both halves from [manifest/manifest.json](../manifest/manifest.json) before the run.
- The hook refuses to run when the Onyx install drifts from the manifest. It checks that each model label maps to the pinned configuration and provider, the indexed corpus, the pinned api_server environment, any pinned patch (`apply.sh check`), and the auto-filter setting against the declared `EVAL_AUTO_FILTERS`. It creates the personas if missing and clears the eval user's memories. The search settings are checked by `npm run seed` and `npm run verify`, not on every run; the Onyx commit is recorded, not checked.
- Saved answers can be re-judged without calling Onyx: [promptfooconfig.regrade.yaml](../promptfooconfig.regrade.yaml).
- Every judged answer is in [results/answers/](../results/answers/), one JSON line per answer, with the documents the model was given and each judge's verdict and reason. The raw promptfoo output (search results and telemetry) is not in the repo.

## The Onyx install

Pinned in [manifest/manifest.json](../manifest/manifest.json):

- Onyx commit `06aa2b09cc4aa5135fa2627e5235814e996f1514` (4 Sep 2026).
- Embedding model `nomic-ai/nomic-embed-text-v1`, multipass indexing off, contextual retrieval off (except in the `ctx` setup).
- `max_chunks_fed_to_chat`: 25. Image extraction off.
- background container: `LLM_SOCKET_READ_TIMEOUT=180`, `SKIP_METADATA_IN_CHUNK=true`.
- api_server container: `SECONDARY_LLM_FLOW_TIMEOUT_S=300` (see the qwen limits below).
- The version-filter patch, when a setup uses it.

## What Onyx does per question

One search turn. The answering model does every LLM step.

1. **Date step** (only with auto filters on, `auto_detect_search_filters`). Stock Onyx asks the model which document dates the conversation restricts the search to. The version-filter patch replaces this step. It runs in parallel with the query rewrites.
2. **Query rewrite.** The model writes search queries. Onyx adds its own rewrite and a keyword expansion.
3. **Search.** 50 chunks come back, from every version in the document set unless a filter narrows it.
4. **Section pick.** The hits are trimmed to a token budget. The model then picks at most 10 sections to read (`select_sections_for_expansion`, `max_sections=10`, hard-coded). Picked sections are expanded with neighbouring chunks and merged. At most 25 chunks reach the answer step.
5. **Relevance checks.** The model checks the sections for relevance, many calls at once.
6. **Answer.** The model writes the answer with inline citations.

Most setups change one of these steps.

## Corpus

14 unmodified PDFs of Authorised Versions from legislation.vic.gov.au:

- Residential Tenancies Act 1997: 9 versions (088, 089, 090, 097, 098, 101, 110, 111, 115).
- Residential Tenancies Regulations 2021: 4 versions (002, 004, 005, 009).
- Residential Tenancies (Rooming House Standards) Regulations 2023: 1 version (002).

[corpus/manifest.yaml](../corpus/manifest.yaml) lists each file's source URL, SHA-256, size and in-force dates. Some Act versions are there only as distractors. Onyx's file connector extracts the PDF text, so extraction is part of the system under test.

Each file carries tags in its Onyx metadata: `instrument`, `version`, `version_id`, `in_force_from`, `in_force_to`. These are the "in-force labels". They were added to the index on 3 Nov 2026 (see the `labels` and `datefilter` setups).

The PDFs are not in the repo (see [NOTICE](../NOTICE)). [scripts/fetch-corpus.py](../scripts/fetch-corpus.py) downloads them and checks the hashes.

## Questions

Questions were paraphrased from public renter forum posts and news stories and restated as Victorian scenarios.

- **Main set: 10 questions, 16 dated slots.** The study and the fix were developed on these. A slot is one question on one scenario date. The question opens with the date ("It is 1 October 2025. ...").
- **Quick subset: 10 cases.** Each main question once, on its earliest date. Most experiments ran on it (`npm run eval:rentals:quick`).
- **Undated copies: 6.** The main slots whose law is the law in force on 4 Nov 2026, with the date sentence cut. The gold is unchanged. File: [cases/vic-rentals-undated.yaml](../cases/vic-rentals-undated.yaml).
- **Held-out set: 8 questions, 10 slots** (4 dated, 6 undated). Chosen, and their gold written, after the fix was frozen. Each dated slot phrases its date in its own words ("I am asking on Tuesday 8 November 2022"). Undated gold is the law in force on 5 Nov 2026.

| question | set | role | slots |
|---|---|---|---|
| [VRQ-035](../questions/VRQ-035/README.md) | main | date-sensitive | 2025-10-01, 2026-02-01 |
| [VRQ-003](../questions/VRQ-003/README.md) | main | date-sensitive | 2025-10-01, 2026-02-01 |
| [VRQ-021](../questions/VRQ-021/README.md) | main | date-sensitive | 2023-03-01, 2026-10-15, undated copy |
| [VRQ-004](../questions/VRQ-004/README.md) | main | date-sensitive | 2025-10-01, 2026-02-01 |
| [NEWSQ-005](../questions/NEWSQ-005/README.md) | main | date-sensitive | 2019-11-01, 2026-10-15, undated copy |
| [VRQ-001](../questions/VRQ-001/README.md) | main | needs more facts | 2026-10-15, undated copy |
| [WPQ-005](../questions/WPQ-005/README.md) | main | needs more facts | 2026-10-15, undated copy |
| [VRQ-010](../questions/VRQ-010/README.md) | main | partly outside the law documents | 2026-10-15, undated copy |
| [VRQ-028](../questions/VRQ-028/README.md) | main | law is silent | 2026-10-15, undated copy |
| [NEWSQ-008](../questions/NEWSQ-008/README.md) | main | story | 2025-10-01, 2026-02-01 |
| [VRQ-011](../questions/VRQ-011/README.md) | held-out | date-sensitive | 2026-01-15, undated |
| [VRQ-022](../questions/VRQ-022/README.md) | held-out | date-sensitive | 2019-10-15, undated |
| [NEWSQ-003](../questions/NEWSQ-003/README.md) | held-out | partly outside the law documents | 2025-12-03 |
| [WPQ-008](../questions/WPQ-008/README.md) | held-out | law unchanged across versions | 2022-11-08 |
| [VRQ-020](../questions/VRQ-020/README.md) | held-out | law unchanged across versions | undated |
| [VRQ-013](../questions/VRQ-013/README.md) | held-out | law unchanged across versions | undated |
| [VRQ-027](../questions/VRQ-027/README.md) | held-out | partly outside the law documents | undated |
| [VRQ-016](../questions/VRQ-016/README.md) | held-out | law unchanged across versions | undated |

### Gold format

Each `questions/<ID>/README.md` holds the gold the author wrote. Per slot:

- **Must cite:** the documents and versions in force on the date.
- **Correct answer (short)**.
- **Must mention:** the required points.
- **Optional:** credit, not required.
- **Must not say**.
- **Pass / fail rule**.

It also lists the law passages the gold rests on, with links to the official PDFs, and the facts the question leaves open. `question.yaml` records where each passage sits in the extracted corpus text, with a hash. [scripts/make-rental-cases.py](../scripts/make-rental-cases.py) compiles the gold into [cases/](../cases/), and `npm run cases` compiles those into `datasets/`.

The gold was checked against the judge: [promptfooconfig.goldcheck.yaml](../promptfooconfig.goldcheck.yaml) feeds each gold answer to the rubrics, and each should pass.

Some gold was revised after first runs. Rule: a required point that no model states even with the gold's passages in hand (the `oracle` setups) moves to optional credit. Each README records its status and any revision. All scores in this repo are on the current gold.

## Personas

Each persona is an Onyx assistant created by the setup hook from [manifest/manifest.json](../manifest/manifest.json). `replace_base_system_prompt` is false, so Onyx's own base prompt still applies. `datetime_aware` tells Onyx whether to give the model today's date.

### rentals (default)

`datetime_aware`: false.

> **System:** You are a careful research assistant answering questions about Victorian residential tenancy law. Answer only from the retrieved documents. The question gives the date it is asked on: apply the version of the law in force on that date, and name the document and its Authorised Version number. If the documents do not contain the answer, say so plainly rather than guessing.
>
> **Task:** First say what the law says about the situation, then what the renter can do or ask. Cite every factual claim inline using the [1], [2] markers for the retrieved documents. Keep the answer concise and in plain language.

### rentals-v2 (stricter prompt)

`datetime_aware`: false.

> **System:** You are a careful research assistant answering questions about Victorian residential tenancy law. Answer only from the retrieved documents. The question gives the date it is asked on. The retrieved documents may include several versions of the same Act or Regulations: use only the version in force on that date, and name the document, its Authorised Version number and the version's date. Do not apply a rule or suggest a step taken from any other version, even with a caveat; at most, note that the law was different before or changes later. If the answer depends on facts the question does not give, say so and name the facts that decide it. If the documents have no rule on something the user asks about, say that plainly instead of guessing or filling it in from elsewhere.
>
> **Task:** First say what the law in force on the date says about the situation, including what it does not require or does not cover where that matters to the user, then what the renter can do or ask. Cite every factual claim inline using the [1], [2] markers for the retrieved documents. Keep the answer concise and in plain language.

### rentals-undated (undated questions)

`datetime_aware`: true.

> **System:** You are a careful research assistant answering questions about Victorian residential tenancy law. Answer only from the retrieved documents. The question is being asked today: apply the version of the law in force today, and name the document and its Authorised Version number. If the documents do not contain the answer, say so plainly rather than guessing.
>
> **Task:** First say what the law says about the situation, then what the renter can do or ask. Cite every factual claim inline using the [1], [2] markers for the retrieved documents. Keep the answer concise and in plain language.

### rentals-oracle (passages in the message, no search)

`datetime_aware`: false. No search tool.

> **System:** You are a careful research assistant answering questions about Victorian residential tenancy law. The message gives the law passages to use, each headed with its document, Authorised Version number and location, and then the question. Answer only from those passages. The question gives the date it is asked on, and the passages are from the versions of the law in force on that date: apply them, and name the document and its Authorised Version number. If the passages do not contain the answer, say so plainly rather than guessing.
>
> **Task:** First say what the law says about the situation, then what the renter can do or ask. Name the document and version each point rests on. Keep the answer concise and in plain language.

## Models

| label | model | how Onyx reaches it |
|---|---|---|
| haiku | claude-haiku-5-5 | gateway |
| luna | gpt-5.6-luna | gateway |
| luna-api | gpt-5.6-luna | Onyx's direct `openai` provider |
| sonnet | claude-sonnet-5-5 | gateway |
| sol | gpt-5.6-sol | gateway |
| sol-api | gpt-5.6-sol | Onyx's direct `openai` provider |
| opus | claude-opus-5-5 | gateway |
| qwen | qwen3.6:35b | local Ollama (`ollama_chat`) |

- "Gateway" is an OpenAI-compatible gateway in front of the Anthropic and OpenAI APIs, registered in Onyx as one LLM provider.
- luna-api and sol-api are the same models as luna and sol. Only the Onyx provider differs.
- qwen is Qwen3.6 35B-A3B (mixture of experts) on one 16 GB GPU, with experts offloaded to RAM. Its `max_input_tokens` in Onyx is 65536, which Onyx passes to Ollama as the context size. Ollama serves it one request at a time.
- The `model_configuration_id` values in the manifest are database ids in the author's install. On another install, set them to yours ([reproduce.md](reproduce.md)).

## Judge

- **claude-opus-5-5** judges every answer in this repo, at temperature 0, with up to 4096 output tokens, through any OpenAI-compatible endpoint (`JUDGE_MODEL`, `JUDGE_BASE_URL`).
- Runs before 2 Nov 2026 were first judged by other models. They were all re-judged with claude-opus-5-5. See the comment in [promptfooconfig.regrade.yaml](../promptfooconfig.regrade.yaml).
- On 9 Nov 2026 version-cited was re-judged on every answer to the two 2019 cases (vr-newsq-005-2019-11-01, vr-ho-vrq-022-2019-10-15) after the rubric gained its "Amendments Not in Operation" warning: 30 of 154 verdicts went from pass to fail, 3 gold passes were lost. See hand-check batch 3.
- The setup hook refuses a judge from the same model family as an answering model, unless that judge is cleared by a hand-check. claude-opus-5-5 is cleared on the hand-check of haiku answers ([src/setup.ts](../src/setup.ts), `SAME_FAMILY_CLEARED`).

### Blind hand-check

The author labelled a sample of answers point by point, with no model, setup or judge verdict shown, then compared the labels with the judge. Tool: [scripts/hand-check.py](../scripts/hand-check.py). The sample answers are from haiku, luna and qwen.

- **Batch 1:** 20 answers from the quick cases, filters off and perfect filter. Agreement 59 of 60 checks. The judge rules were revised against this batch. Sheet: [sheet.md](../results/hand-check/sheet.md), score: [score.md](../results/hand-check/score.md).
- **Batch 2:** 15 fresh answers, from the filters-on runs and the 6 non-quick cases with filters off. Agreement 44 of 45 checks. This is the independent check of the revised rules. Sheet: [sheet2.md](../results/hand-check/sheet2.md), score: [score2.md](../results/hand-check/score2.md).
- **Batch 3 (second judge):** gpt-6-astra re-judged 92 answers (r1 of `datefilter` and `heldout`, every model) with the same rubrics and agreed with claude-opus-5-5 on 262 of 276 verdicts. The 14 splits were labelled by hand: the label sided with Opus on 8 and astra on 6, and on Claude answers 6 to 5. astra was right on all 4 version-cited splits, three of them the "Amendments Not in Operation" trap the rubric now warns about. Not blind like batches 1 and 2: the labels were made in discussion of each item. Sheet: [sheet3.md](../results/hand-check/sheet3.md), score: [score3.md](../results/hand-check/score3.md).

## Setups

[results/setups.md](../results/setups.md) lists every setup, date step, model and run count. "Filters" (the date step) takes three values:

- **off:** `npm run filters -- off`. No date step. Search covers every version.
- **on:** `npm run filters -- on`. Onyx's date step runs: stock Onyx, or the version-filter patch where a setup says so. The patch does nothing while filters are off.
- **asof (perfect filter):** filters off, and the search is limited to a hand-built document set holding only the versions in force on the scenario date.

Unless stated, a setup uses persona `rentals`, document set `vic-rentals-baseline`, the 10 quick cases, and 3 runs.

### baseline

- The main matrix. All 16 dated cases with filters off and on (stock Onyx, no patch). The 10 quick cases with the perfect filter.
- Models: haiku, luna, qwen.
- Perfect filter: [scripts/build-asof-corpora.py](../scripts/build-asof-corpora.py) writes one document set per scenario date ([corpus/asof-manifest.yaml](../corpus/asof-manifest.yaml)), each seeded with `npm run seed -- --corpus vic-rentals-asof-<date>`. [promptfooconfig.rentals-asof.yaml](../promptfooconfig.rentals-asof.yaml) points each case at its date's set (`npm run eval:rentals:asof`).
- The filters-off runs were made before the index carried the in-force labels.

### pick25

- What changed: the section-pick cap and the candidate pool, edited in Onyx's code inside the running api_server container on 2 Nov 2026, and reverted after.
  - `max_sections`: 10 -> 25.
  - `SELECTION_TOKEN_BUDGET_MULTIPLIER`: 2 -> 6. With 6, all 50 search hits reach the picker.
- Filters off. Models: haiku, qwen. luna was skipped: it picks 3 to 5 sections by choice, so a higher cap would not change what it reads.

### prompt2

- What changed: persona `rentals-v2` instead of `rentals` (providers `rentals-v2:<model>`).
- Filters off. Models: haiku, luna, qwen.

### sonnet

- What changed: model sonnet (provider `rentals:sonnet`).
- Filters off.

### sol

- What changed: model gpt-5.6-sol. Run 1 through the gateway (`sol`), runs 2 and 3 through Onyx's direct openai provider (`sol-api`).
- Filters off.

### opusarm

- What changed: model opus (provider `rentals:opus`). The answering model is the judge model.
- Filters off.

### ctx

- What changed: contextual retrieval at indexing, on 3 Nov 2026. Before embedding, Onyx asks an LLM for a summary of each document and a short context for each chunk, and embeds them with the chunk. They are not shown to the answering model; they only change what search returns.
- How:
  - A new search-settings version with `enable_contextual_rag` on and qwen3:4b-instruct on the local Ollama as the context model.
  - Re-index through Onyx's "port flow": a new search setting re-embeds the existing chunks without re-fetching the files, and it runs the contextual step. A normal re-index skips unchanged documents, so it would not add context.
  - A patch in the running background container: Onyx trims each document to the context model's `max_input_tokens` with its own tokenizer, which counts fewer tokens than Qwen's, and passes the same number to Ollama as `num_ctx`. Every summary call then overflowed. The patch gives Ollama 1.75 times that budget.
  - `CONTEXTUAL_RAG_LLM_TIMEOUT=900` (seconds).
- Then: filters off for haiku, luna, qwen, sonnet (3 runs) and sol (1 run); perfect filter for haiku (3 runs).
- Reverted the same day: a search setting with contextual retrieval off, through the port flow again. The `num_ctx` patch was lost when the container was recreated.

### labels

- What changed: nothing in Onyx's settings. The index now carries the in-force labels, and this setup measures them alone.
- The labels were added on 3 Nov 2026 by re-seeding with the tags in [corpus/manifest.yaml](../corpus/manifest.yaml). Each section the model receives then shows the file name, its date and the tags (instrument, version, version_id, in_force_from, in_force_to). Before, the metadata held only the PDF's own properties.
- Stock Onyx: the version-filter patch removed from the container. Filters off. Models: haiku, luna, qwen.
- The baseline filters-off runs predate the labels. This setup separates the labels' effect from the filter's.

### datefilter

- What changed: the version-filter patch, with filters on.
- How: `onyx-patches/version-filter/apply.sh apply` in the api_server container; selection rule `labels` (the default); `npm run filters -- on`. The manifest pins the patch, so the hook runs `apply.sh check` before each run.
- Models: haiku, luna, qwen, sonnet, opus, sol-api.
- haiku, luna and qwen ran on 3 Nov 2026, before the as-at prompt was revised on 4 Nov (see the patch README's "Changes").

### datefilter-rest

- Same as datefilter, on the 6 dated cases outside the quick subset (the second date of 6 main questions).
- Model: haiku. Revised as-at prompt.

### latest-dated

- What changed: the patch's label-free selection rule. `apply.sh rule latest-dated`. Per title family (the file name without its version and date tokens), search uses the file with the latest file date on or before the as-at date. The in-force labels are ignored.
- Filters on. Model: haiku. On this corpus it picks the same versions as the `labels` rule.

### undated

- What changed: the 6 undated copies ([datasets/vic-rentals-undated.yaml](../datasets/vic-rentals-undated.yaml), `npm run eval:rentals:undated`) and persona `rentals-undated` (providers `rentals-undated:<model>`).
- off: stock search over every version.
- on: the patch. No date stated, so the question is answered as at today, and search covers each instrument's current version.
- Gold: the law in force on 4 Nov 2026. Models: haiku, luna, qwen.

### undated-j1

- What changed: the undated `on` setup for qwen, with one case at a time (`-j 1`, `npm run eval:rentals:local`) and `SECONDARY_LLM_FLOW_TIMEOUT_S=300` in the api_server environment (Onyx's default is 60 s).
- One run. It checks whether qwen's timeouts go away.

### oracle

- What changed: no search. The message is the gold's law passages, then the question. Persona `rentals-oracle` (no search tool), [promptfooconfig.rentals-oracle.yaml](../promptfooconfig.rentals-oracle.yaml), `npm run eval:rentals:oracle`.
- [scripts/make-oracle-dataset.py](../scripts/make-oracle-dataset.py) cuts each passage in full from the corpus text and heads it with the document, Authorised Version number and location. The dataset quotes the law, so it is built locally and not committed.
- Retrieval is recorded as a pass by construction. The setup measures the writing step alone.
- Models: haiku, luna, qwen, sonnet, opus, sol-api.

### heldout

- What changed: the held-out dated slots ([cases/vic-rentals-heldout.yaml](../cases/vic-rentals-heldout.yaml), `npm run eval:rentals:heldout`). Persona `rentals`.
- off: stock search, the patch installed but dormant. on: the patch, `labels` rule, revised as-at prompt.
- Models: haiku, luna-api, qwen, sonnet.

### heldout-undated

- Same as heldout, on the held-out undated slots ([cases/vic-rentals-heldout-undated.yaml](../cases/vic-rentals-heldout-undated.yaml), `npm run eval:rentals:heldout-undated`), with persona `rentals-undated`.

### heldout-oracle

- The oracle setup on all 10 held-out slots (`make-oracle-dataset.py --heldout`).
- Models: haiku, luna-api, qwen, sonnet.

### heldout-pick25 and heldout-undated-pick25

- What changed: the pick25 edit on top of the patch. `max_sections` 10 -> 25 and `SELECTION_TOKEN_BUDGET_MULTIPLIER` 2 -> 6 in the running api_server, on 6 Nov 2026. Reverted after (10 and 2, `apply.sh check` passing, filters off).
- Filters on (the patch). Model: haiku. Held-out dated slots, and held-out undated slots with persona `rentals-undated`.

## The version-filter patch

An in-container patch to Onyx's search tool. It makes Onyx's date step pick, per instrument, the version in force on the question's date before the model sees anything. Full description: [onyx-patches/version-filter/README.md](../onyx-patches/version-filter/README.md). Code and the as-at prompt: [version_filter.py](../onyx-patches/version-filter/version_filter.py).

- **As-at question.** Stock Onyx asks which document dates the search is restricted to. The patch asks instead, in one LLM call on the answering model, what date the question should be answered as at. A date the situation is judged at counts ("It is 1 October 2025"). A date that only marks a step in a situation asked about now does not ("I sent the form three weeks ago").
- **No date means today.** Search then covers each instrument's current version.
- **Selection.** Search is restricted, through a `tags` filter on `version_id`, to the chosen version of each instrument.
  - Rule `labels` (default): the version whose `in_force_from` to `in_force_to` range covers the as-at date.
  - Rule `latest-dated`: per title family, the latest file date on or before the as-at date. It needs no hand-written labels, only a file date that is the version's own date.
- **Install:** `apply.sh apply`, `check`, `revert`, `rule labels|latest-dated`. The patch lives only in the container's filesystem; recreating the api_server drops it.

## Known limits

- **Small n.** 10 main questions (16 dated slots, 10 in the quick subset) and 8 held-out questions (10 slots). A one-case change is often inside run-to-run spread.
- **Three runs.** Some cells have fewer: sol in `ctx` has one run, `undated-j1` has one.
- **The fix was developed on the main set.** The held-out set exists to test it on questions it never met.
- **Same-family judge.** The judge is a Claude model, as are haiku, sonnet and opus. Batches 1 and 2 of the hand-check sampled haiku, luna and qwen answers only. Batch 3 tested the judge against a second judge from another family (gpt-6-astra) on every model and found no lean towards Claude answers, but its human labels cover only the 14 verdicts where the judges split, 3 of them Sonnet or Opus answers. Opus is the judge model itself. Read their answers, not only the verdicts.
- **One author.** The author wrote the gold and did the hand-check.
- **Index state differs over time.** Setups run before the re-seed of 3 Nov 2026 used an index without the in-force labels. The `labels` setup measures that difference.
- **Patch prompt versions.** The as-at prompt was revised on 4 Nov 2026. Earlier patched runs used the first version.
- **Two providers for luna and sol.** luna/luna-api and sol/sol-api are the same models through different Onyx providers.
- **qwen timeouts.** Ollama serves qwen one request at a time, while Onyx sends many relevance checks at once. Until `undated-j1`, qwen ran with Onyx's default 60 s timeout for these secondary calls and two cases at a time. Some relevance checks and section picks timed out; Onyx then keeps the section unexpanded or uses the top hits by rank. At least one patched answer came back empty when its date call timed out. Since `undated-j1` the manifest pins `SECONDARY_LLM_FLOW_TIMEOUT_S=300`.
- **"labels" means two things.** The `labels` setup is the labelled index with no filter, on stock Onyx. The patch's `labels` rule is the selection rule that reads those labels to filter. `datefilter` uses the rule; the `labels` setup does not.
