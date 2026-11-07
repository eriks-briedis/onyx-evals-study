# Glossary

**Study terms**

| term | meaning |
|---|---|
| question | one renter's situation and question, e.g. [VRQ-035](../questions/VRQ-035/README.md). 18 in all |
| main set | the 10 questions the study was developed on |
| held-out set | 8 questions chosen, and their gold written, after the fix was frozen, to check that it generalises |
| slot, case | one question asked on one date. A question asked on two dates straddles a change in the law. Case ids look like `vr-vrq-035-2025-10-01`; `vr-ho-` marks the held-out set |
| scenario date | the date a case's question is set on ("It is 1 October 2025."). The answer must use the law in force that day |
| undated | a case asked with no date, so it means "now": the law in force when the study ran (4-5 November 2026) |
| quick cases | the subset that asks each main question once, on its earliest date: 10 of the 16 main cases |
| gold | the written correct answer for a slot: points it must mention, things it must not say, and the documents and versions it must cite |
| optional credit | a point worth stating but not required |
| must-mention | judge check: the answer states every required point |
| must-not-say | judge check: the answer says none of the listed wrong things |
| version-cited | judge check: the answer names each required document with the version in force on the date, and applies no rule from another version |
| retrieval | deterministic check: Onyx's search returned the expected documents |
| gold pass | retrieval and all three judge checks pass. The study's headline measure |
| setup | one configuration of Onyx and the eval, run 3 times. Listed in [results/setups.md](../results/setups.md) |
| arm, model label | the answering model: haiku, luna, sonnet, sol, opus, qwen. `luna-api` and `sol-api` are the same models through Onyx's direct OpenAI provider instead of the gateway |
| persona | the Onyx assistant the question is sent to: its system and task prompt. `rentals` is the default; `rentals-v2`, `rentals-undated` and `rentals-oracle` are variants ([manifest](../manifest/manifest.json)) |
| date step | what Onyx does with the question's date before searching: off, stock, patch or asof ([results/README.md](../results/README.md)) |
| asof, perfect filter | searching a document set that holds only the versions in force on the date. Built by hand; the upper bound for a date filter |
| the fix, the patch | the [version-filter patch](../onyx-patches/version-filter/): Onyx asks the model "answered as at what date?" and searches only the versions in force that day |
| passage oracle | the model is given the gold's law passages in the message and has no search: what it still gets wrong is the writing, not the retrieval |
| dropped point | a must-mention point the judge says an answer left out |
| fed / other ver / searched / missing | where a dropped point's passage was: given to the model from the right version, given only from another version, in the search results but not given to the model, or not found |
| section pick | the Onyx step where the answering model picks up to 10 of the search results to read in full |
| contextual retrieval (ctx) | an Onyx indexing option that has an LLM write a short context for every chunk before embedding it |
| gold check | running the judge over the gold answers themselves: every check should pass, or the rubric or the gold is wrong |
| hand-check | answers labelled by a person without seeing the judge's verdicts, to measure the judge ([results/hand-check/](../results/hand-check/)) |

**Question ids.** The prefix records where the question was first noticed: VRQ and WPQ from
public renter forums, NEWSQ from news stories. Every question was rewritten as a Victorian
scenario, and none quotes its source.

**Setup tags** (details in [docs/method.md](method.md)): `baseline` (the main matrix),
`pick25` (section pick of 25 instead of 10), `prompt2` (stricter prompt), `sonnet`, `sol`,
`opusarm` (bigger answering models), `bigger` (the sonnet and sol reports together), `ctx`
(contextual retrieval), `labels` (version and in-force labels on every chunk, no filter),
`oracle` (passage oracle), `datefilter` and `datefilter-rest` (the patch), `latest-dated` (the
patch's label-free rule), `undated`, `undated-j1`, and the `heldout*` setups.

**Legal terms**

| term | meaning |
|---|---|
| Authorised Version | an official consolidated copy of an Act or Regulations as amended up to a date, numbered (Act version 110, Regulations version 004) and published on legislation.vic.gov.au |
| in force | the version that states the law on a given day: from the day it took effect until the day before the next version |
| the Act | Residential Tenancies Act 1997 (Vic) |
| the Regulations | Residential Tenancies Regulations 2021 (Vic) |
| Rooming House Standards | Residential Tenancies (Rooming House Standards) Regulations 2023 (Vic) |
| rental minimum standards | the standards a rented home must meet (Schedule 4 to the Regulations) |
| VCAT | the Victorian Civil and Administrative Tribunal, which hears rental disputes |
| rental provider, renter | the Act's terms for landlord and tenant since 29 March 2021 |
