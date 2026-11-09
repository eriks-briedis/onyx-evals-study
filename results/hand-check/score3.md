# Hand check vs judges - batch 3

Generated from sheet3.md. The sample is every verdict where claude-opus-5-5 (the judge of record) and gpt-6-astra (a second judge, same rubrics, temperature 0) disagreed, on 92 answers: r1 of `datefilter` (10 cases x haiku, sonnet, opus, luna, sol, qwen) and r1 of `heldout` filters on and off (4 cases x haiku, sonnet, luna, qwen). Overall the judges agreed on 262 of 276 verdicts.

| rubric | splits | label agrees with Opus | label agrees with astra |
|---|---|---|---|
| must-mention | 8 | 6 | 2 |
| must-not-say | 2 | 2 | 0 |
| version-cited | 4 | 0 | 4 |
| all | 14 | 8 | 6 |

## Items

| item | model | case | rubric | label | Opus | astra | notes |
|---|---|---|---|---|---|---|---|
| H301 | qwen | vr-ho-vrq-022-2019-10-15 | version-cited | fail | pass | fail | astra's reason overstated (para (k) unsafe-premises route existed in v088); fails on the categorical 'is legally classified as an urgent repair' claim, taken from the not-yet-in-force 2018 amendment printed in v088 |
| H302 | haiku | vr-ho-vrq-022-2019-10-15 | version-cited | fail | pass | fail |  |
| H303 | sonnet | vr-newsq-008-2025-10-01 | must-mention | pass | pass | fail |  |
| H304 | haiku | vr-vrq-004-2025-10-01 | must-mention | pass | pass | fail | hedge ("probably not enough") still shows which way it falls; sets the bar for hedged items |
| H305 | qwen | vr-vrq-003-2025-10-01 | must-not-say | pass | pass | fail | omits the renter signature but does not assert landlord can withdraw alone |
| H306 | haiku | vr-ho-vrq-011-2026-01-15 | must-mention | pass | pass | fail | treats bank transfer as the fee-free method; short answer framing (probably cannot make you pay a card fee) leans against the gold but is not what the point tests |
| H307 | haiku | vr-newsq-005-2019-11-01 | version-cited | fail | pass | fail | every notice section cited (91ZK, 91ZX-91ZZD, 91ZZI) is from the not-in-operation appendix; misses s 266(2), concludes no retaliation protection |
| H308 | haiku | vr-vrq-028-2026-10-15 | version-cited | pass | fail | pass | Rooming House Standards Regs named only by link 23-10sra002; rubric accepts link-naming |
| H309 | opus | vr-newsq-005-2019-11-01 | must-not-say | pass | pass | fail | 30 days is correct 2019 law (s 321B) for ss 255-260 notices; 60 days given for the s 263 notice |
| H310 | haiku | vr-wpq-005-2026-10-15 | must-mention | fail | pass | fail | payment raised only as a documents gap; advice does not branch on the arrangement |
| H311 | sonnet | vr-vrq-003-2025-10-01 | must-mention | fail | pass | fail | not blind (seen in the 3-answer test); outcome tied to landlord intention, not the ground stated in the notice and its evidence |
| H312 | sol-api | vr-newsq-008-2025-10-01 | must-mention | pass | pass | fail | uninvited offer not prohibited + invited-or-not is the deciding question; consistent with H303 |
| H313 | haiku | vr-ho-newsq-003-2025-12-03 | must-mention | pass | pass | fail | GOLD BUG: point 2 requires the seven days notice (and point 1 mentions the key), but the question as asked states neither; both are only in the scenario notes. Fix: add the notice and key to the question text (re-run the case) or drop the seven-days clause |
| H314 | haiku | vr-vrq-028-2026-10-15 | must-mention | pass | pass | fail | not blind (same answer as H308); documents-dont-say covers the absence point |

## What it shows

- **No sign that Opus favours Claude answers.** On Claude answers the label sided with Opus 6 times and astra 5. The Opus-kinder lean on Claude answers in the raw split counts (10 of 11) came from the version-cited gap below plus astra being too strict elsewhere.
- **version-cited: astra right 4 of 4.** Three are one trap: Authorised Versions 088 and 089 print the 2018 reforms (most commenced 29 March 2021) at the back under "Amendments Not in Operation". haiku and qwen applied them as the 2019 law (mould as an urgent repair, ss 91ZK and 91ZX-91ZZD), and Opus passed them because the answer cited v088. Fixed after this batch: the case builder notes such sections on the dates they apply and the rubric tells the judge (scripts/make-rental-cases.py `NOT_IN_OPERATION`, src/cases.ts `notInOperation`). A version that told the judge to fail any rule it knew came later failed correct answers from memory (the 14-day sale-contract ground in v110 s 91ZZB, the payment-fee disclosure in v111 s 42(7)), so the warning is grounded in the corpus instead. Re-judged on the same 92, the grounded rubric matches all 4 labels here.
- **must-mention and must-not-say: Opus right 8 of 10.** astra failed answers the rubric passes: "the documents don't say X" for an absence point, a lean that still shows which way a point falls, a deadline stated for a different kind of notice. astra was right on the two points that need the outcome to turn on a stated fact (H310, H311).
- **Gold pass on the 92:** Opus 47, with these labels 46, astra 39. No model's ranking changes.
- **A gold bug** (H313, NEWSQ-003): the must-mention point needs the seven days' notice and the agent's key, which are in the question's scenario notes but not in the question as asked.

## Limits

- The sample is the 14 splits, chosen because the judges disagreed, so it measures which judge is right where they differ, not either judge's overall error rate (batches 1 and 2 do that for Opus: 103 of 105).
- Not independent: the assistant gave a suggested reading before each label, and every label matched it. H311 and H314 were also seen before labelling (H311 in a 3-answer test, H314 is the same answer as H308).
- One labeller, not a lawyer.
