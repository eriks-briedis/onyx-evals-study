#!/usr/bin/env python3
"""A replay file whose "answers" are the gold answers, to run the judge over its own gold.

A test oracle check: every gold answer, with the must-cite list appended as its sources,
should pass must-mention, must-not-say and version-cited. A failure is a rubric or gold bug,
not a model result. Writes results/goldcheck/replay-<dataset>.json in the shape
src/replay.ts reads; promptfooconfig.goldcheck.yaml judges it:

  python3 scripts/make-goldcheck-replay.py datasets/vic-rentals.yaml
  REPLAY_RESULTS=results/goldcheck/replay-vic-rentals.json REGRADE_DATASET=datasets/vic-rentals.yaml \\
    JUDGE_MODEL=claude-opus-5-5 npx promptfoo eval --no-cache -c promptfooconfig.goldcheck.yaml \\
    -o results/goldcheck/vic-rentals.json
"""
import json
import pathlib
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
CASES = [ROOT / f'cases/vic-rentals{s}.yaml' for s in ('', '-undated', '-heldout', '-heldout-undated')]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dataset = ROOT / sys.argv[1]
    gold = {}
    for p in CASES:
        if p.exists():
            gold.update({c['id']: c for c in yaml.safe_load(p.read_text())})
    results = []
    for t in yaml.safe_load(dataset.read_text()):
        cid = t['metadata']['id']
        c = gold[cid]
        answer = (c.get('extra') or {})['gold_answer'].strip()
        answer += '\n\nThis rests on: ' + '; '.join(c.get('must_cite') or []) + '.'
        results.append({
            'testCase': {'metadata': {'id': cid}},
            'provider': {'id': 'gold', 'label': 'gold'},
            'response': {'output': {'answer': answer, 'top_documents': [], 'tool_calls': [], 'citation_info': []}},
            'latencyMs': 0,
        })
    out = ROOT / 'results/goldcheck' / f'replay-{dataset.stem}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({'config': {'description': f'gold answers of {dataset.name}'}, 'results': {'results': results}}, indent=2, ensure_ascii=False))
    print(f'{out.relative_to(ROOT)}: {len(results)} gold answers')


if __name__ == '__main__':
    main()
