#!/usr/bin/env python3
"""Export every judged answer of the study, one JSON record per answer, to results/answers/<setup>.jsonl,
and the list of what ran to results/setups.md.

The raw promptfoo output (results/**/rentals-filters-<filters>-<model>.json, about 1.3 GB with the
search results and telemetry) is not in the repo. This keeps what a reader needs to check a number:
the question, the answer, the documents it was given, each judge's verdict and reason, and the
latest re-judge where one was run (results/**/regraded/). The summaries in results/*.md were
computed from the raw files by the other scripts here.

Raw run folders: results/ (run 1 of the baseline), results/repeats/r<N>/ (its runs 2 and 3) and
results/variants/<setup>/r<N>/.

  python3 scripts/export-answers.py [--results DIR]   # DIR holds the raw run folders (default results/)
"""
import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import study

GOLD = study.GOLD
CHECKS = ['retrieval'] + GOLD
OUT = study.RESULTS / 'answers'
# Runs judged on the first draft of the held-out gold (three points no model stated with the passages
# in hand were then made optional); the final held-out runs replace them.
SKIP_DIRS = ('heldout-gold1', 'heldout-undated-gold1')

SETUPS = {
    'baseline': "the main matrix: 16 cases; Onyx's date step off and on (stock), and the perfect filter (asof) on the 10 quick cases",
    'pick25': 'section-picking cap raised from 10 to 25, candidate pool 2x -> 6x (stock search, quick cases)',
    'prompt2': 'stricter prompt, persona rentals-v2 (stock search, quick cases)',
    'sonnet': 'claude-sonnet-5-5 answering (stock search, quick cases)',
    'sol': 'gpt-5.6-sol answering (stock search, quick cases)',
    'opusarm': 'claude-opus-5-5 answering (stock search, quick cases); same family as the judge',
    'ctx': 'contextual retrieval on at indexing (quick cases)',
    'labels': 'version and in-force labels on every chunk, no filter (stock search, quick cases)',
    'datefilter': 'the version-filter patch, date step on (quick cases)',
    'datefilter-rest': 'the version-filter patch on the 6 non-quick cases (haiku)',
    'latest-dated': "the patch's label-free rule: per title, the latest file dated on or before the as-at date",
    'undated': 'the 6 undated questions, persona rentals-undated: stock search (off) vs the patch answering as at today (on)',
    'undated-j1': 'the undated questions on qwen, one case at a time, 300 s secondary-flow timeout (one run)',
    'oracle': "the passage oracle: the gold's law passages in the message, no search (quick cases)",
    'heldout': 'held-out set, dated slots (4): stock (off) vs the patch (on)',
    'heldout-undated': 'held-out set, undated slots (6): stock (off) vs the patch (on)',
    'heldout-oracle': "held-out set with the gold's passages in the message, no search",
    'heldout-pick25': 'held-out dated slots, the patch on, section-pick cap 10 -> 25 and pool 2x -> 6x (haiku)',
    'heldout-undated-pick25': 'held-out undated slots, the same probe',
}
# Where "filters on" ran the version-filter patch rather than Onyx's stock date step.
PATCHED = {'datefilter', 'datefilter-rest', 'latest-dated', 'undated', 'undated-j1', 'heldout', 'heldout-undated',
           'heldout-pick25', 'heldout-undated-pick25'}


def date_step(setup, filters):
    if filters == 'asof':
        return 'perfect filter (one document set per date)'
    if filters == 'off':
        return 'off (every version searched)'
    return 'version-filter patch' if setup in PATCHED else "Onyx's stock date filter"


def verdicts(r):
    out = {}
    for c in (r.get('gradingResult') or {}).get('componentResults', []):
        metric = (c.get('assertion') or {}).get('metric')
        if metric:
            out[metric] = {'pass': None if (c.get('metadata') or {}).get('graderError') else c.get('pass'),
                           'reason': c.get('reason') or ''}
    return out


def fed_titles(out):
    """The documents of the chunks the model was given, one entry per chunk."""
    titles = []
    for call in out.get('tool_calls') or []:
        raw = call.get('tool_result')
        if call.get('tool_name') == 'internal_search' and isinstance(raw, str) and raw.startswith('{'):
            try:
                titles += [x.get('title') for x in json.loads(raw).get('results', [])]
            except ValueError:
                pass
    return titles


def results_files(root):
    for p in sorted(root.rglob('rentals-filters-*.json')):
        if 'regraded' in p.parts or p.name.startswith('partial') or any(d in p.parts for d in SKIP_DIRS):
            continue
        if 'superseded' in str(p) or 'broken' in str(p):
            continue
        yield p


def setup_of(p, root):
    parts = p.relative_to(root).parts
    if parts[0] == 'variants':
        setup, run = parts[1], parts[2]
    elif parts[0] == 'repeats':
        setup, run = 'baseline', parts[1]
    else:
        setup, run = 'baseline', 'r1'
    m = re.match(r'rentals-filters-(\w+)-([\w-]+)\.json', p.name)
    return setup, m.group(1), m.group(2), run


def load_answers(root):
    rows = []
    for p in results_files(root):
        setup, filters, model, run = setup_of(p, root)
        doc = json.loads(p.read_text())
        judges = [study.judge_of(doc) or 'unknown']
        redone = defaultdict(dict)
        for ov in sorted((p.parent / 'regraded').glob(p.name.removesuffix('.json') + '[.]*json')):
            ov_doc = json.loads(ov.read_text())
            judges.append(study.judge_of(ov_doc) or 'unknown')
            for r in ov_doc['results']['results']:
                redone[r['testCase']['metadata']['id']].update(verdicts(r))
        for r in doc['results']['results']:
            md = r['testCase'].get('metadata', {})
            out = (r.get('response') or {}).get('output') or {}
            out = out if isinstance(out, dict) else {}
            v = {**verdicts(r), **redone.get(md.get('id'), {})}
            gold = bool((v.get('retrieval') or {}).get('pass')) and all(bool((v.get(g) or {}).get('pass')) for g in GOLD)
            rows.append(dict(
                setup=setup, filters=filters, date_step=date_step(setup, filters), model=model, run=run,
                case=md.get('id'), question_id=md.get('question_id'), scenario_date=md.get('scenario_date'),
                persona=(r.get('provider') or {}).get('label'), question=r['testCase'].get('vars', {}).get('question'),
                answer=out.get('answer', ''), error=out.get('error_msg') or (r.get('response') or {}).get('error'),
                latency_s=round((r.get('latencyMs') or 0) / 1000), documents_searched=len(out.get('top_documents') or []),
                chunks_fed=fed_titles(out), verdicts={k: v.get(k) for k in CHECKS}, gold_pass=gold,
                judge=', '.join(dict.fromkeys(judges)), raw_file=str(p.relative_to(root))))
    return rows


def write(rows):
    OUT.mkdir(parents=True, exist_ok=True)
    by_setup = defaultdict(list)
    for r in rows:
        by_setup[r['setup']].append(r)
    for setup, rs in by_setup.items():
        rs.sort(key=lambda r: (r['filters'], r['model'], r['run'], r['case']))
        with (OUT / f'{setup}.jsonl').open('w') as f:
            for r in rs:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
    counts = defaultdict(lambda: defaultdict(set))
    for r in rows:
        key = (r['setup'], r['filters'], r['model'])
        counts[key]['runs'].add(r['run'])
        counts[key]['cases'].add(r['case'])
        counts[key]['n'].add((r['run'], r['case']))
    order = list(SETUPS)
    lines = ['# What ran', '', 'Generated by scripts/export-answers.py. Every (setup, date step, model) the study ran; '
             'the answers are in results/answers/<setup>.jsonl. Runs are independent repeats.', '',
             '## Setups', '', '| setup | what changed |', '|---|---|']
    lines += [f'| [{s}](answers/{s}.jsonl) | {what} |' for s, what in SETUPS.items() if s in by_setup]
    lines += ['', '## Runs', '', '| setup | date step | model | runs | cases | answers |', '|---|---|---|---|---|---|']
    for (setup, filters, model), c in sorted(counts.items(), key=lambda kv: (order.index(kv[0][0]) if kv[0][0] in order else 99,
                                                                          kv[0][2], kv[0][1])):
        lines.append(f"| {setup} | {date_step(setup, filters)} | {model} | {len(c['runs'])} | {len(c['cases'])} | {len(c['n'])} |")
    (study.RESULTS / 'setups.md').write_text('\n'.join(lines) + '\n')
    print(f'{len(rows)} answers -> {OUT.relative_to(study.ROOT)}/ ({len(by_setup)} setups); results/setups.md')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--results', type=Path, default=study.RESULTS, help='folder holding the raw run folders')
    write(load_answers(ap.parse_args().results.resolve()))


if __name__ == '__main__':
    main()
