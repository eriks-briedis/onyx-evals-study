#!/usr/bin/env python3
"""What the study cost, per answer and per arm: results/cost.md.

Sources:
- Onyx's user_usage table (per model, per pipeline stage: query rewrites, section picking,
  relevance checks, the answer), read with docker exec + psql for the eval user.
- promptfoo results: answers per arm, and the judge's tokens (gradingResult.tokensUsed).
- Constants measured from the Ollama log for the contextual-retrieval indexing run.

Prices are API list prices (USD per million tokens, PRICES below). Local models cost
electricity only.
"""
import glob
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path

import study

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'results/cost.md'
PRICES = {  # USD per 1M tokens, (input, output); list prices checked 5 Nov 2026
    'claude-opus-5-5': (4.00, 20.00),
    'claude-sonnet-5-5': (2.00, 10.00),
    'claude-haiku-5-5': (0.10, 0.50),  # the rate for prompts up to 100k tokens; every call here is under that
    'gpt-5.6-luna': (0.20, 1.20),  # after the 30 Jul 2026 cut (was 1.00 / 6.00)
    'gpt-5.6-sol': (5.00, 30.00),  # OpenAI's rate; Bedrock lists 4.00 / 20.00
}
# Arm labels luna-api and sol-api (the same models through the OpenAI API) fold into luna and sol: the
# answers() regex reads `arm=luna` from `arm=luna-api`, and Onyx's usage table keys on the model name.
ARM_MODEL = {'haiku': 'claude-haiku-5-5', 'sonnet': 'claude-sonnet-5-5', 'opus': 'claude-opus-5-5',
             'luna': 'gpt-5.6-luna', 'sol': 'gpt-5.6-sol', 'qwen': 'qwen3.6:35b'}
JUDGE = 'claude-opus-5-5'
# Contextual-retrieval indexing, 3 Nov 2026 08:42-10:56 AEDT, qwen3:4b-instruct on a 16 GB RTX 5060 Ti,
# 2 Ollama slots: from `docker logs ollama` (task.n_tokens per request).
CTX_INDEX = {'calls': 11408, 'prompt_tokens': 10_740_679, 'output_tokens_est': 11408 * 50, 'gpu_hours': 2.25,
             'chunks': 10068, 'documents': 26}
STAGE = {'chat_response': 'answer', 'select_sections_for_expansion': 'section picking',
         'classify_section_relevance': 'relevance checks', 'keyword_query_expansion': 'query rewrites',
         'semantic_query_rephrase': 'query rewrites', 'time_filter_extraction': 'date filter'}


def psql(sql):
    container = study.env().get('ONYX_DB_CONTAINER', 'onyx-relational_db-1')
    out = subprocess.run(['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', 'postgres',
                          '-tAc', sql], capture_output=True, text=True, check=True).stdout
    return [line.split('|') for line in out.strip().splitlines() if line]


def usage():
    email = study.env()['ONYX_EVAL_USER_EMAIL']
    rows = psql(f"select m.model, m.flow, sum(m.input_tokens), sum(m.output_tokens), sum(m.cost_cents) "
                f"from user_usage m join \"user\" u on u.id=m.user_id where u.email='{email}' group by 1,2")
    per = defaultdict(lambda: defaultdict(lambda: [0, 0, 0.0]))
    for model, flow, inp, outp, cents in rows:
        s = per[model][STAGE.get(flow, flow)]
        s[0] += int(inp); s[1] += int(outp); s[2] += float(cents)
    return per


def results_files():
    for f in glob.glob(str(ROOT / 'results/**/rentals-filters-*.json'), recursive=True):
        if '/regraded/' in f or 'superseded' in f or 'broken' in f:
            continue
        yield f


def answers_and_judge():
    """Answers per arm, and judge tokens per answer measured on Opus-judged runs."""
    answers = defaultdict(int)
    judge = {'prompt': 0, 'completion': 0, 'answers': 0}
    for f in results_files():
        d = json.load(open(f))
        desc = d.get('config', {}).get('description', '')
        arm = re.search(r'arm=(\w+)', desc)
        arm = arm.group(1) if arm else re.search(r'filters-\w+-(\w+)\.json', f).group(1)
        rs = d['results']['results']
        answers[arm] += len(rs)
        if f'judge={JUDGE}' in desc:
            for r in rs:
                t = (r.get('gradingResult') or {}).get('tokensUsed') or {}
                judge['prompt'] += t.get('prompt', 0); judge['completion'] += t.get('completion', 0)
                judge['answers'] += 1
    return answers, judge


def dollars(model, inp, outp):
    if model in PRICES:
        i, o = PRICES[model]
        return inp / 1e6 * i + outp / 1e6 * o
    return None


def main():
    per = usage()
    answers, judge = answers_and_judge()
    lines = ['# What the study cost', '',
             'Per answer means one eval question through Onyx: query rewrites, the section-picking step, the relevance checks and the answer itself, '
             'all on the arm\'s model. Onyx records these per model and stage; answers per arm come from the saved results. '
             'Prices are API list prices checked 5 Nov 2026 (Claude Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50; GPT-5.6 Luna $0.20/$1.20, Sol $5/$30 per million input/output tokens). Local models cost electricity only.', '',
             '## Tokens and cost per answer, by arm', '',
             '| arm | model | answers | input tokens per answer | output per answer | of which the answer step | section picking | relevance checks | cost per answer |',
             '|---|---|---|---|---|---|---|---|---|']
    totals = {}
    for arm, model in ARM_MODEL.items():
        n = answers.get(arm, 0)
        if n == 0 or model not in per:
            continue
        st = per[model]
        inp = sum(v[0] for v in st.values()); outp = sum(v[1] for v in st.values()); cents = sum(v[2] for v in st.values())
        usd = dollars(model, inp, outp)
        cost = f'${usd / n:.3f}' if usd is not None else (f'${cents / 100 / n:.2f} (Onyx estimate)' if cents else '$0 (local)')
        pct = lambda k: f"{100 * st[k][0] / inp:.0f}%" if k in st and inp else '-'
        lines.append(f'| {arm} | {model} | {n} | {inp // n:,} | {outp // n:,} | {pct("answer")} | {pct("section picking")} | {pct("relevance checks")} | {cost} |')
        totals[arm] = (n, inp, outp, usd, cents)
    lines += ['', 'Note: the answer counts include every run of the arm (both filter settings, the perfect-filter arm, repeats and variants), so the per-answer figures are averages over all of them.', '']
    jp, jc, jn = judge['prompt'], judge['completion'], judge['answers']
    jusd = dollars(JUDGE, jp, jc)
    lines += ['## The judge', '',
              f'- {JUDGE} grades three rubrics per answer. Measured over {jn:,} Opus-judged answers: {jp // max(jn, 1):,} input and {jc // max(jn, 1):,} output tokens per answer, '
              f'about ${jusd / max(jn, 1):.3f} per answer at list price.',
              f'- One full setup (16 cases) costs about ${16 * jusd / max(jn, 1):.2f} to judge; the 3-run matrix of 6 setups about ${16 * 6 * 3 * jusd / max(jn, 1):.2f}.',
              '- Earlier judges (gpt-6-astra, Sonnet) read the same prompts; switching every arm to Opus roughly doubled the judge cost per answer and was worth it: in the blind hand-check it agreed with the human label on 103 of 105 verdicts (results/hand-check/).', '']
    lines += ['## What a 3-run experiment costs (10 quick cases, 3 runs = 30 answers)', '', '| arm | answers | judging | total |', '|---|---|---|---|']
    for arm, (n, inp, outp, usd, cents) in totals.items():
        a = (usd / n * 30) if usd is not None else (cents / 100 / n * 30 if cents else 0.0)
        j = jusd / max(jn, 1) * 30
        tag = '' if usd is not None else (' (Onyx estimate)' if cents else ' (local)')
        lines.append(f'| {arm} | ${a:.2f}{tag} | ${j:.2f} | ${a + j:.2f} |')
    c = CTX_INDEX
    lines += ['', '## Contextual retrieval indexing (one-off)', '',
              f"- {c['documents']} documents, {c['chunks']:,} chunks: {c['calls']:,} calls to qwen3:4b-instruct on local Ollama, {c['prompt_tokens'] / 1e6:.1f}M prompt tokens plus about {c['output_tokens_est'] / 1e6:.1f}M output, {c['gpu_hours']} GPU hours on a 16 GB card.",
              f"- The same calls at API prices: about ${dollars('claude-haiku-5-5', c['prompt_tokens'], c['output_tokens_est']):.0f} on Haiku 5.5, ${dollars('claude-sonnet-5-5', c['prompt_tokens'], c['output_tokens_est']):.0f} on Sonnet 5.5.",
              '- Every re-index with contextual retrieval on repeats this; every new version of an Act adds about 650 chunk calls.']
    OUT.write_text('\n'.join(lines))
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
