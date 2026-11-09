# Reproduce the study

There are two levels.

- **Check the published numbers.** You need Python 3 and PyYAML. Nothing calls Onyx or a model.
- **Re-run the study.** You need a self-hosted Onyx, Anthropic and OpenAI API access, a judge
  endpoint, Langfuse, and a GPU for the local model.

Terms are in [glossary.md](glossary.md). What each setup changed is in [method.md](method.md#setups).

## Level 1: check the published numbers

1. Every judged answer is one JSON line in [results/answers/](../results/answers/), one file per
   setup. Each line holds the question, the answer, the documents of the chunks the model was
   given (`chunks_fed`), each judge's verdict and reason, `gold_pass`, the judge, and the raw
   file it came from.
2. Rebuild the summary from those answers:

   ```
   python3 scripts/summarise-answers.py
   ```

   It rewrites [results/summary.md](../results/summary.md). If the file does not change, the
   published numbers follow from the published answers.
3. [results/setups.md](../results/setups.md) lists every setup, date step, model and run count.

The other summaries in [results/](../results/) were computed from the raw promptfoo output
(about 1.3 GB, not in the repo). Rebuilding them needs a re-run (see [Analysis](#analysis)).

## Level 2: re-run the study

### What you need

- **Onyx**, self-hosted with docker compose, at commit
  `06aa2b09cc4aa5135fa2627e5235814e996f1514` (4 Sep 2026), the value of `onyx_commit` in
  [manifest/manifest.json](../manifest/manifest.json). Nothing in the code checks the commit.
- **Docker access to the Onyx containers** from the machine that runs the harness.
  - `npm run seed` reads the background container's environment and log.
  - Every eval run reads the api_server container's environment and runs the patch's `check`.
  - The patch is installed with `docker cp` and `docker exec`.
  - Without docker, set `ONYX_SKIP_DOCKER_CHECKS=1`. The seed and run checks are then skipped,
    so you must confirm those settings yourself. The patch, `usage-cost.py` and
    `datefilter-log.py` still need docker.
- **Langfuse v4 with ClickHouse**, receiving Onyx's traces. Langfuse v4 in `events_only` mode
  has no public trace API, so the harness reads ClickHouse directly (`CLICKHOUSE_*` in `.env`).
  This repo does not cover how to point Onyx at Langfuse. ClickHouse is needed by:
  - the run hook's telemetry join, which writes `results/telemetry-<runId>.json` (skipped with a
    warning when ClickHouse is unreachable);
  - `npm run test:live`;
  - `scripts/compare-filter-runs.py` and `scripts/query-dates.py`.
- **A judge**: any OpenAI-compatible endpoint that serves `claude-opus-5-5` (`JUDGE_BASE_URL`,
  `JUDGE_MODEL`). The configs send the API key `unused`; edit them if your endpoint needs a key.
  `scripts/dropped-points.py` also calls `claude-haiku-5-5` through this endpoint.
- **Anthropic and OpenAI API access, configured as Onyx LLM providers:**
  - one provider that reaches `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`,
    `gpt-5.6-luna` and `gpt-5.6-sol`. The study used an OpenAI-compatible gateway in front of
    both APIs. The manifest names it in `llm_provider_name` (`"LLM Router"`, the gateway
    provider);
  - Onyx's direct `openai` provider, for the `luna-api` and `sol-api` labels.
- **Ollama and a GPU** for the qwen arm: `qwen3.6:35b`, registered in Onyx as an `ollama_chat`
  provider. The author used one 16 GB GPU with the model's experts offloaded to system RAM.
- **Node.js 22 or later**, **Python 3 with PyYAML**, and **pdftotext** (poppler).

**The pdftotext caveat.** Each law passage is stored as character offsets into the
`pdftotext -layout` output, with a SHA-256 of the text. A different poppler version may lay the
text out differently. The scripts then stop with an error that names the passage
(`A different pdftotext version may lay the text out differently.`). The recorded offsets match
pdftotext 24.02.0.

### The Onyx settings the study depends on

| setting | value | what it is for | checked by |
|---|---|---|---|
| Eval user | a dedicated admin account, made with `npm run bootstrap` | The hook wipes the calling account's name, role, memories and preferences, and turns memory off, so prompts carry no account state. | Every run refuses any other account unless `ONYX_ALLOW_DIRTY_USER=1`. |
| Auto search filters (`auto_detect_search_filters`, workspace) | `npm run filters -- on` or `off` | Turns Onyx's date step on or off. The version-filter patch replaces that step. | A run with `EVAL_AUTO_FILTERS=on` or `off` refuses to start when Onyx disagrees. Unset, the run records whatever is set. |
| Search settings | embedding `nomic-ai/nomic-embed-text-v1`, contextual retrieval off | The index every setup except `ctx` searched. | `npm run seed`, `npm run verify` |
| Image extraction and analysis (workspace) | `image_extraction_and_analysis_enabled: false` | On by default. With no vision model set, Onyx picks one itself, and the images inside the PDFs stalled indexing. | `npm run seed`, `npm run verify` |
| `LLM_SOCKET_READ_TIMEOUT` (background) | `180` | A local model sends nothing until it has read the whole prompt, and the 60 s default cut long documents during indexing. | `npm run seed` |
| `SKIP_METADATA_IN_CHUNK` (background) | `true` | Keeps PDF properties (dates, producer, author) out of the chunk text. With them in, Onyx silently skipped contextual retrieval for some PDFs. | `npm run seed` |
| `SECONDARY_LLM_FLOW_TIMEOUT_S` (api_server) | `300` | Relevance checks and the section pick give up at 60 s by default. qwen answers one request at a time while Onyx sends up to 30 per search. | every run |
| `max_input_tokens` of the qwen model configuration (Onyx database) | `65536` | Onyx passes it to Ollama as the context size. The default, 262144, would reserve a 256k cache. Re-saving the Ollama provider in Onyx resets it. | nothing |
| The version-filter patch (api_server filesystem) | see [step 10](#steps) | The fix the study tests. | every run, while the manifest lists it in `onyx_api_server_patches` |
| `max_chunks_fed_to_chat` | `25` | Recorded in the manifest. | nothing |

Set the container environment values in Onyx's `deployment/docker_compose/.env`. Then recreate
only that service, from Onyx's `deployment/docker_compose` folder:

```
docker compose up -d --force-recreate --no-deps background
docker compose up -d --force-recreate --no-deps api_server
```

Keep `--no-deps`: without it, compose also recreates the database and Redis, and every login is
lost. Recreating api_server drops the patch, so apply it again afterwards.

Set the qwen context size in the database (use your qwen configuration id):

```
docker exec onyx-relational_db-1 psql -U postgres -d postgres -c \
  "update model_configuration set max_input_tokens = 65536 where id = <qwen id>;"
```

The hook creates each persona in [manifest/manifest.json](../manifest/manifest.json) by name on
its first run and never updates it. If you edit a prompt in the manifest, delete that persona in
Onyx first.

### Model configuration ids

Each model in `manifest.models` has a `model_configuration_id`. These are database row ids in the
author's Onyx install, so yours will differ. Every run and every seed checks every model in the
list, not only the ones you run. For each one, the configuration must:

- exist in Onyx;
- belong to the provider the model names in `provider`, or else to `llm_provider_name`
  (matched on the provider's Onyx name, or on its type when it has no name);
- have the same model name as `model_name`.

Otherwise the run stops with `Model axis does not match Onyx`.

To find your ids:

1. Add the providers and models in Onyx.
2. List the configurations through Onyx's API (`GET /api/admin/llm/provider`, as the eval user):

   ```
   set -a; . ./.env; set +a
   curl -s -c onyx.cookies --data-urlencode "username=$ONYX_EVAL_USER_EMAIL" \
     --data-urlencode "password=$ONYX_EVAL_USER_PASSWORD" "$ONYX_BASE_URL/api/auth/login"
   curl -s -b onyx.cookies "$ONYX_BASE_URL/api/admin/llm/provider" | python3 -c '
   import json, sys
   for p in json.load(sys.stdin)["providers"]:
       for m in p["model_configurations"]:
           print(m["id"], p["name"] or p["provider"], m["name"], sep="\t")'
   rm onyx.cookies
   ```

   Each line is: configuration id, provider, model name.
3. Edit [manifest/manifest.json](../manifest/manifest.json):
   - set each model's `model_configuration_id` to your id;
   - set `llm_provider_name` to your gateway provider's name in Onyx;
   - keep `provider` as `openai` for `luna-api` and `sol-api`, and `ollama_chat` for `qwen`, or
     change it to the name your provider has;
   - delete the models you will not run.
4. Check:

   ```
   npm run verify
   ```

   It prints the configuration behind each label and fails on any mismatch. It creates nothing.

### Steps

1. Install Onyx at the pinned commit and start it with docker compose, following Onyx's own
   instructions:

   ```
   git clone https://github.com/onyx-dot-app/onyx
   git -C onyx checkout 06aa2b09cc4aa5135fa2627e5235814e996f1514
   ```

   Set the environment values from the table above. The harness expects the containers
   `onyx-api_server-1`, `onyx-background-1` and `onyx-relational_db-1`. If yours differ, set
   `ONYX_API_SERVER_CONTAINER`, `ONYX_BACKGROUND_CONTAINER` and `ONYX_DB_CONTAINER` in `.env`.
2. Install the harness and make your `.env`:

   ```
   npm ci
   cp .env.example .env
   ```

   Fill in `ONYX_BASE_URL`, `ONYX_EVAL_USER_EMAIL`, `ONYX_EVAL_USER_PASSWORD`, `JUDGE_BASE_URL`,
   `JUDGE_MODEL` and the `CLICKHOUSE_*` values. [.env.example](../.env.example) explains each one.
3. Create the eval user. It asks for an existing admin's login once, or reads
   `ONYX_ADMIN_EMAIL` and `ONYX_ADMIN_PASSWORD`:

   ```
   npm run bootstrap
   ```

4. Turn image analysis off if it is on (`PATCH /api/admin/settings` with
   `{"image_extraction_and_analysis_enabled": false}`; `npm run verify` prints the exact fix).
   Turn the auto filters off:

   ```
   npm run filters -- off
   ```

5. Set the model configuration ids and run `npm run verify` ([above](#model-configuration-ids)).
6. Download the 14 law PDFs and extract their text. Each download must match the size and SHA-256
   in [corpus/manifest.yaml](../corpus/manifest.yaml):

   ```
   python3 scripts/fetch-corpus.py
   ```

7. Build the cases and run the offline tests:

   ```
   npm run cases
   npm test
   ```

8. Build the passage-oracle datasets. They quote the law in full, so they stay local:

   ```
   npm run oracle
   ```

9. Seed the corpus. It uploads the PDFs with their in-force tags, waits for indexing (up to
   3 hours) and points the document set `vic-rentals-baseline` at them. An unchanged corpus is a
   no-op.

   ```
   npm run seed
   ```

   Seed the five perfect-filter sets too. `scripts/build-asof-corpora.py` already wrote
   [corpus/asof-manifest.yaml](../corpus/asof-manifest.yaml) and the manifest's
   `extra_corpora`, so you do not need to run it.

   ```
   for d in 2019-11-01 2023-03-01 2025-10-01 2026-02-01 2026-10-15; do
     npm run seed -- --corpus vic-rentals-asof-$d
   done
   ```

10. Apply the version-filter patch ([its README](../onyx-patches/version-filter/README.md)).
    With the auto filters off, the patch does nothing.

    ```
    onyx-patches/version-filter/apply.sh apply
    onyx-patches/version-filter/apply.sh check
    ```

    The patch's anchors are lines of Onyx's `search_tool.py` at the pinned commit. On another
    commit `apply` may stop with `anchor not found exactly once`.
11. Run `npm run verify` once more, then run the setups ([below](#running-a-setup)).

### Running a setup

Every run has this shape:

```
npm run filters -- <off|on>
EVAL_AUTO_FILTERS=<off|on> npm run <script> -- <extra flags> \
  --filter-providers '^<persona>:<model>$' \
  --description 'rentals <setup> r<N> filters=<off|on|asof> arm=<model> judge=claude-opus-5-5' \
  -o <folder>/rentals-filters-<off|on|asof>-<model>.json
```

- **One model per run.** `--filter-providers` is a regular expression on the provider label, so
  anchor it: `rentals:luna` would also match `rentals:luna-api`.
- **qwen** runs one case at a time: add `-j 1` (`npm run eval:rentals:local` does this for
  `eval:rentals`). Ollama serves this model one request at a time.
- **The description** carries the judge. The analysis scripts read `judge=` from it, and
  `usage-cost.py` reads `arm=` and `judge=`.
- **The file name** carries the date step and the model label, never the persona:
  `rentals-filters-<off|on|asof>-<model>.json`. The `asof` tag is for the perfect-filter config.
- **The folder** is the setup and run:
  - `results/` for run 1 of the baseline;
  - `results/repeats/r2/` and `results/repeats/r3/` for its runs 2 and 3;
  - `results/variants/<setup>/r<N>/` for every other setup.
- **The auto filters are a workspace setting.** Do not switch them while another run is going.
- Raw output files are git-ignored (`results/**/*.json`).

Example: run 2 of `datefilter` on haiku.

```
npm run filters -- on
EVAL_AUTO_FILTERS=on npm run eval:rentals -- --filter-metadata quick=true \
  --filter-providers '^rentals:haiku$' \
  --description 'rentals datefilter r2 filters=on arm=haiku judge=claude-opus-5-5' \
  -o results/variants/datefilter/r2/rentals-filters-on-haiku.json
```

The setups, as in [results/setups.md](../results/setups.md). "quick" means
`--filter-metadata quick=true` (the 10 quick cases). "Patch" is the state of the version-filter
patch in the api_server container.

| setup | script | extra flags | persona | filters | patch | models | runs |
|---|---|---|---|---|---|---|---|
| baseline | `eval:rentals` | none (16 cases) | `rentals` | off, on | off: either; on: removed (see below) | haiku, luna, qwen | 3 |
| baseline, perfect filter | `eval:rentals:asof` | quick | `rentals` | off, file tag `asof` | either | haiku, luna, qwen | 3 |
| pick25 | `eval:rentals` | quick | `rentals` | off | either, plus a hand edit | haiku, qwen | 3 |
| prompt2 | `eval:rentals` | quick | `rentals-v2` | off | either | haiku, luna, qwen | 3 |
| sonnet | `eval:rentals` | quick | `rentals` | off | either | sonnet | 3 |
| sol | `eval:rentals` | quick | `rentals` | off | either | sol (run 1), sol-api (runs 2, 3) | 3 |
| opusarm | `eval:rentals` | quick | `rentals` | off | either | opus | 3 |
| ctx | `eval:rentals`, `eval:rentals:asof` | quick | `rentals` | off; `asof` for haiku | either, plus a hand change | off: haiku, luna, qwen, sonnet, sol; asof: haiku | 3 (sol 1) |
| labels | `eval:rentals` | quick | `rentals` | off | removed | haiku, luna, qwen | 3 |
| datefilter | `eval:rentals` | quick | `rentals` | on | applied, rule `labels` | haiku, luna, qwen, sonnet, opus, sol-api | 3 |
| datefilter-rest | `eval:rentals` | `--filter-metadata quick=false` | `rentals` | on | applied, rule `labels` | haiku | 3 |
| latest-dated | `eval:rentals` | quick | `rentals` | on | applied, rule `latest-dated` | haiku | 3 |
| undated | `eval:rentals:undated` | none | `rentals-undated` | off, on | applied | haiku, luna, qwen | 3 |
| undated-j1 | `eval:rentals:undated` | `-j 1` | `rentals-undated` | on | applied | qwen | 1 |
| oracle | `eval:rentals:oracle` | none | `rentals-oracle` | off | either | haiku, luna, qwen, sonnet, opus, sol-api | 3 |
| heldout | `eval:rentals:heldout` | none | `rentals` | off, on | applied | haiku, luna, qwen, sonnet | 3 |
| heldout-undated | `eval:rentals:heldout-undated` | none | `rentals-undated` | off, on | applied | haiku, luna, qwen, sonnet | 3 |
| heldout-oracle | `eval:rentals:oracle` | `--tests datasets/vic-rentals-heldout-oracle.yaml` | `rentals-oracle` | off | either | haiku, luna, qwen, sonnet | 3 |
| heldout-pick25 | `eval:rentals:heldout` | none | `rentals` | on | applied, plus a hand edit | haiku | 3 |
| heldout-undated-pick25 | `eval:rentals:heldout-undated` | none | `rentals-undated` | on | applied, plus a hand edit | haiku | 3 |

**Patch states.**

- *Applied*: `apply.sh apply` has run and `apply.sh check` passes. The manifest lists the patch,
  so every run checks this.
- *Either*: with the filters off the patch does nothing. Leave it applied.
- *Removed*: stock Onyx. Run `onyx-patches/version-filter/apply.sh revert`, and set
  `"onyx_api_server_patches": []` in the manifest so the hook stops checking for it. Restore both
  afterwards. The baseline's `on` runs measure Onyx's own date filter, so they need this.
- The selection rule is read on each search, with no restart:
  `onyx-patches/version-filter/apply.sh rule latest-dated` for `latest-dated`, then
  `apply.sh rule labels` to go back.

**Setups changed by hand inside Onyx.** `pick25`, `ctx`, `labels`, `heldout-pick25` and
`heldout-undated-pick25` need a change that no script makes. [method.md](method.md#setups)
gives the exact change for each, and how it was reverted.

### Analysis

| script | writes | needs |
|---|---|---|
| [summarise-answers.py](../scripts/summarise-answers.py) | `results/summary.md` | `results/answers/` only |
| [export-answers.py](../scripts/export-answers.py) | `results/answers/<setup>.jsonl`, `results/setups.md` | the raw run files in the folders above; `--results DIR` reads them from elsewhere |
| [repeat-summary.py](../scripts/repeat-summary.py) | `results/repeat-summary.md` | raw baseline runs: `results/`, `results/repeats/r2/`, `results/repeats/r3/` |
| [heldout-summary.py](../scripts/heldout-summary.py) | `results/heldout-summary.md` | raw runs in `results/variants/heldout/r1-3/` and `results/variants/heldout-undated/r1-3/` |
| [compare-filter-runs.py](../scripts/compare-filter-runs.py) | `results/filters-comparison.md` | raw baseline run 1 (`results/rentals-filters-<on/off/asof>-<haiku/luna/qwen>.json`) and ClickHouse |
| [query-dates.py](../scripts/query-dates.py) | `results/query-dates.md` | raw baseline run 1 and ClickHouse |
| [dropped-points.py](../scripts/dropped-points.py) | `results/dropped-points[-<tag>].md` and `results/dropped-points[-<tag>]/*.csv` | raw runs, a live Onyx (password login as the eval user, for chunk text), and the judge endpoint serving `claude-haiku-5-5` |
| [usage-cost.py](../scripts/usage-cost.py) | `results/cost.md` | raw runs, and `docker exec ... psql` on `ONYX_DB_CONTAINER` (default `onyx-relational_db-1`) for the eval user's usage rows |
| [datefilter-log.py](../scripts/datefilter-log.py) | the terminal | `docker logs` of the api_server container, between `--since` and `--until` |
| [hand-check.py](../scripts/hand-check.py) | `results/hand-check/` | raw runs |

`dropped-points.py` with no arguments reads the three baseline runs. For any other setup, pass a
tag and the run folders. Each report's first lines give the exact command it was made with, for
example:

```
python3 scripts/dropped-points.py --tag datefilter \
  results/variants/datefilter/r1 results/variants/datefilter/r2 results/variants/datefilter/r3
```

After your runs, `python3 scripts/export-answers.py` and then
`python3 scripts/summarise-answers.py` give the same files as the published ones.

### Re-judging saved answers

[promptfooconfig.regrade.yaml](../promptfooconfig.regrade.yaml) replays a saved answer file
through the current asserts and judges. It does not call Onyx, and it does not run the setup hook,
so nothing checks the judge's model family.

- `REPLAY_RESULTS`: the saved promptfoo `-o` file (one model per file).
- `REGRADE_DATASET`: the dataset its cases come from (default `datasets/vic-rentals.yaml`; for
  example `datasets/vic-rentals-undated.yaml` for an undated run).
- `REGRADE_IDS`: optional, comma-separated case ids to re-judge only those.
- `REGRADE_JUDGES`: optional, comma-separated judges to re-run (`must-mention`, `must-not-say`,
  `version-cited`). Unset, every judge runs.
- `JUDGE_MODEL`: the judge (from `.env` when not set).

Rebuild the datasets first (`npm run cases`) so the tests carry the current rubrics. Write the
output to a `regraded/` folder beside the original, named after it. The analysis scripts overlay
its verdicts on the original's, judge by judge:

```
REPLAY_RESULTS=results/variants/datefilter/r2/rentals-filters-on-haiku.json \
REGRADE_JUDGES=version-cited \
  npm run regrade -- -o results/variants/datefilter/r2/regraded/rentals-filters-on-haiku.version-cited.json
```

The deterministic asserts (retrieval among them) always run and assume a search ran. Re-judging
a passage-oracle run this way would record its retrieval as failed.

### Gold check

This checks the test, not Onyx. The gold answers themselves are judged against their own rubrics,
with the must-cite list appended as their sources. Every one should pass. A failure is a rubric
or gold bug.

```
python3 scripts/make-goldcheck-replay.py datasets/vic-rentals.yaml
REPLAY_RESULTS=results/goldcheck/replay-vic-rentals.json REGRADE_DATASET=datasets/vic-rentals.yaml \
  npm run goldcheck -- -o results/goldcheck/vic-rentals.json
```

Repeat with `datasets/vic-rentals-undated.yaml`, `datasets/vic-rentals-heldout.yaml` and
`datasets/vic-rentals-heldout-undated.yaml`. The replay file is
`results/goldcheck/replay-<dataset name>.json`.

### Live tests

```
npm run test:live
```

These need a running, seeded Onyx and the same checks as a run (docker, unless skipped).

- `setup-idempotency`: running the setup twice creates no new connectors, document sets or
  personas.
- `prompt-cleanliness`: sends one question and reads the system prompt Onyx composed from the
  Langfuse trace, so it also needs ClickHouse. On the author's install, its "renders only the
  Basic Information sub-section" check failed from 4 Nov 2026, because Onyx's prompt gained a
  `## Language` sub-section.

## What will differ for you

- **Newer law.** The corpus is fixed at 14 PDFs by checksum. If legislation.vic.gov.au replaces a
  file, `fetch-corpus.py` refuses it. Newer Authorised Versions are not in the library, so
  answers may be out of date for real use.
- **The undated gold is fixed.** The undated questions are graded on the law in force on
  4 Nov 2026 (main set) and 5 Nov 2026 (held-out set), not on the day you run them.
- **The index carries the in-force labels.** `npm run seed` always uploads them. The published
  baseline runs predate the labels; the `labels` setup measures that difference.
- **Model drift.** Hosted models change behind the same name, and names get retired. If you
  change a `model_name`, you are measuring a different model.
- **Judge drift.** The judge is a hosted model too. Use the [gold check](#gold-check) to see
  whether it still passes the gold.
- **A different Onyx commit.** API routes, prompts and the patch's anchors may differ. Nothing
  checks the commit for you.
- **Timing.** The qwen arm's speed depends on your GPU. Each answer took several minutes on the
  author's.
