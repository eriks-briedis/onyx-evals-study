#!/usr/bin/env python3
"""Hand-check the judges: label a sample of saved answers blind, then compare with the judge.

  python3 scripts/hand-check.py make [batch]    picks the answers, writes results/hand-check/sheet<batch>.md
                                               (no model, arm or judge verdict shown) and key<batch>.json
  python3 scripts/hand-check.py score [batch]   reads the labels back and writes results/hand-check/score<batch>.md

Batch 1 (the default; files without a number) is 20 answers from the 10 quick cases in the
filters-off and perfect-filter (asof) runs; the judge rules were revised against it. Batch 2 is
15 fresh answers to check those rules on: the filters-on runs and the 6 non-quick filters-off
cases. Both are judged against the current gold (datasets/vic-rentals.yaml). Every label is y (the answer passes this point) or
n; a ? left in place is reported as unlabelled. Judge verdicts come from
study.load(), so re-judges are included.
"""
import json, random, re, sys
from pathlib import Path

import yaml

import study

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'results/hand-check'
BATCH = sys.argv[2] if len(sys.argv) > 2 else '1'
SUFFIX = '' if BATCH == '1' else BATCH
SHEET, KEY, SCORE = OUT / f'sheet{SUFFIX}.md', OUT / f'key{SUFFIX}.json', OUT / f'score{SUFFIX}.md'
# batch -> (size, seed, the (run, quick case?) pairs the pool draws from)
BATCHES = {'1': (20, 30, {('off', True), ('asof', True)}), '2': (15, 31, {('on', True), ('on', False), ('off', False)})}
SIZE, SEED, POOL = BATCHES[BATCH]
# Borderline or just-flipped verdicts worth a human look; the rest are drawn at random.
MUST = [] if BATCH != '1' else [('asof', 'luna', 'vr-newsq-005-2019-11-01'), ('asof', 'haiku', 'vr-vrq-028-2026-10-15'),
        ('off', 'haiku', 'vr-vrq-001-2026-10-15'), ('off', 'haiku', 'vr-vrq-035-2025-10-01'),
        ('off', 'qwen', 'vr-vrq-001-2026-10-15')]
RUBRICS = {'M': 'must-mention', 'N': 'must-not-say', 'V': 'version-cited'}
LABEL = re.compile(r'^- \[([yn?])\] ([MNV])(\d*)\b', re.I)


def bullets(text):
    return [l[2:].strip() for l in (text or '').splitlines() if l.startswith('- ')]


def answers():
    """(cond, arm, case) -> (answer text, judge verdicts) for the batch's pool."""
    mod, out = study, {}
    for cond in sorted({c for c, _ in POOL}):
        for arm in ('haiku', 'luna', 'qwen'):
            raw = {r['testCase']['metadata']['id']: (r.get('response') or {}).get('output') or {}
                   for r in json.loads((ROOT / f'results/rentals-filters-{cond}-{arm}.json').read_text())['results']['results']}
            for row in mod.load(cond, arm):
                text = raw[row['case']].get('answer') if isinstance(raw[row['case']], dict) else None
                if text and (cond, row['case'] in QUICK) in POOL:
                    out[(cond, arm, row['case'])] = (text, {m: row['metrics'].get(m) for m in RUBRICS.values()})
    return out


def make():
    pool = answers()
    rng = random.Random(SEED)
    picked = list(MUST)
    rest = sorted(set(pool) - set(picked))
    rng.shuffle(rest)
    # Fill evenly by model, alternating judged pass and fail on must-mention, one answer per model and question.
    want = {arm: SIZE // 3 + (arm == 'haiku') * (SIZE % 3) for arm in ('haiku', 'luna', 'qwen')}
    # A second pass drops the balance rule if the first leaves a model short.
    for balance in (True, False):
        for k in rest:
            cond, arm, case = k
            mine = [p for p in picked if p[1] == arm]
            if k in picked or len(mine) >= want[arm] or any(p[2][:-11] == case[:-11] for p in mine):
                continue
            passes = sum(bool(pool[p][1]['must-mention']) for p in mine)
            if not balance or bool(pool[k][1]['must-mention']) == (passes * 2 < len(mine)):
                picked.append(k)
    rng.shuffle(picked)

    lines = ['# Hand check - vic-rentals answers', '',
             'For each answer, replace every ? with y (the answer passes this point) or n. '
             'Judge the answer as written; don\'t look up the judge. Notes are optional.', '',
             '- **M** points: the answer states it (different wording is fine; "the documents don\'t say X" counts '
             'for "the law doesn\'t say X"; listed next steps are examples).',
             '- **N** points: the answer does NOT say this (raising it only to reject it is fine).',
             '- **V**: the answer names every must-cite document with its version (by number, file name, '
             'citation link or the version\'s date), and relies on no other version: if deleting everything '
             'taken from another version would change the answer, it relies on it, caveat or not.', '']
    key = {}
    for i, k in enumerate(picked, 1):
        hid = f'H{i:02d}'
        case = GOLD[k[2]]
        key[hid] = dict(cond=k[0], arm=k[1], case=k[2], judge=pool[k][1])
        # Keep the link's file part: it can carry the version (97-109aa110 is Act v110).
        text = re.sub(r'\[\[(\d+)\]\]\([^)]*/([^/)]+)\)', r'[\1: \2]', pool[k][0]).strip()
        md = case['metadata']
        lines += [f'## {hid} - {md["question_id"]} on {k[2][-10:]}', '', f'**Question:** {case["vars"]["question"]}', '',
                  '**Answer:**', '', '\n'.join('> ' + l for l in text.splitlines()), '',
                  '<details><summary>Gold answer</summary>', '', md['gold_answer'], '', '</details>', '',
                  '**Must cite:** ' + '; '.join(md['must_cite']), '']
        lines += [f'- [?] M{j} {p}' for j, p in enumerate(bullets(md['correct_answer_summary']), 1)]
        lines += [f'- [?] N{j} avoids: {p}' for j, p in enumerate(bullets(md['wrong_answer_looks_like']), 1)]
        lines += ['- [?] V cites the version in force and no other', '', 'Notes:', '']
    OUT.mkdir(parents=True, exist_ok=True)
    SHEET.write_text('\n'.join(lines))
    KEY.write_text(json.dumps(key, indent=2) + '\n')
    print(f'{len(picked)} answers -> {SHEET.relative_to(ROOT)}')
    for hid, v in key.items():
        print(hid, v['cond'], v['arm'], v['case'], 'M' if v['judge']['must-mention'] else 'm')


def score():
    key = json.loads(KEY.read_text())
    # Current verdicts, so a re-judge after make is scored; key.json keeps the ones at make time.
    now = answers()
    labels, hid = {}, None
    for line in (l.strip() for l in SHEET.read_text().splitlines()):
        if line.startswith('## H'):
            hid = line[3:6]
            labels[hid] = {r: [] for r in RUBRICS}
        elif hid and (m := LABEL.match(line)):
            labels[hid][m.group(2).upper()].append(m.group(1).lower())
    agree = {r: [0, 0] for r in RUBRICS.values()}
    rows, unlabelled = [], []
    for hid, k in key.items():
        for code, rubric in RUBRICS.items():
            marks = labels.get(hid, {}).get(code, [])
            if not marks or '?' in marks:
                unlabelled.append(f'{hid} {code}')
                continue
            human, judge = all(m == 'y' for m in marks), now[(k['cond'], k['arm'], k['case'])][1][rubric]
            agree[rubric][0] += human == judge
            agree[rubric][1] += 1
            if human != judge:
                missed = ', '.join(f'{code}{i}' for i, m in enumerate(marks, 1) if m == 'n') or '-'
                rows.append(f'| {hid} | {k["arm"]} | {k["cond"]} | {k["case"]} | {rubric} | {"pass" if human else "fail"} | '
                            f'{"pass" if judge else "fail" if judge is False else "error"} | {missed} |')
    out = ['# Hand check vs judge - vic-rentals', '', 'Generated by scripts/hand-check.py score.', '',
           '| rubric | agree | labelled |', '|---|---|---|']
    out += [f'| {r} | {a} | {n} |' for r, (a, n) in agree.items()]
    out += ['', '## Disagreements', '', '| item | model | run | case | rubric | you | judge | points you failed |',
            '|---|---|---|---|---|---|---|---|'] + rows
    if unlabelled:
        out += ['', 'Unlabelled: ' + ', '.join(unlabelled)]
    SCORE.write_text('\n'.join(out) + '\n')
    print('\n'.join(out))


GOLD = {t['metadata']['id']: t for t in yaml.safe_load((ROOT / 'datasets/vic-rentals.yaml').read_text())}
QUICK = {cid for cid, t in GOLD.items() if t['metadata'].get('quick')}

if __name__ == '__main__':
    {'make': make, 'score': score}[sys.argv[1] if len(sys.argv) > 1 else 'make']()
