#!/usr/bin/env python3
"""Why answers drop must-mention points: which points, what kind, and whether the passage reached the model.

Reads every run (results/, results/repeats/r2, r3) with its re-judge overlays, like compare-filter-runs.py.
For each must-mention failure, claude-haiku-5-5 (through the judge endpoint, JUDGE_BASE_URL) reads the judge's reason and
names the points it says are missing; the verdict itself stays the judge's. Each point is hand-mapped
below (POINTS) to the gold passages behind it (ground_truth_ref in cases/vic-rentals.yaml) and to a kind:
rule, condition, next step, absence (the law doesn't say X) or judgement (no passage decides it).
For every dropped point the passages are looked for in, best first:

  fed         in the chunks the model was given (tool_result), from the right version
  other ver   the same text was given, but only from another version of the document
  searched    a chunk of the right document was in the search results but not given to the model
              (chunk text from Onyx's /document/chunk-info, cached)
  missing     nowhere in the search results
  no passage  the point has no passage to find

Writes results/dropped-points.md, results/dropped-points/points.csv (one row per point per answer) and
results/dropped-points/answers.csv (one row per answer, with verdicts, reasons and the answer text).

  python3 scripts/dropped-points.py                         the 3 main runs
  python3 scripts/dropped-points.py --tag pick25 DIR...     other run folders (one per run); writes
                                                            results/dropped-points-pick25.md and
                                                            results/dropped-points-pick25/*.csv
"""
import argparse, csv, hashlib, http.cookiejar, json, re, sys, urllib.parse, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

import yaml

import study

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / 'results/dropped-points'
ARGS = argparse.ArgumentParser()
ARGS.add_argument('--tag', default='', help='name for a variant; its runs follow as folders')
ARGS.add_argument('dirs', nargs='*', help='run folders holding rentals-filters-<cond>-<arm>.json')
args = ARGS.parse_args()
TAG = f'-{args.tag}' if args.tag else ''
OUT_DIR = ROOT / f'results/dropped-points{TAG}'
OUT = ROOT / f'results/dropped-points{TAG}.md'
RUNS = ({i: Path(d).resolve() for i, d in enumerate(args.dirs, 1)} if args.dirs
        else {1: ROOT / 'results', 2: ROOT / 'results/repeats/r2', 3: ROOT / 'results/repeats/r3'})
ARMS, CONDS = ('haiku', 'sonnet', 'luna', 'luna-api', 'sol', 'qwen', 'opus'), ('on', 'off', 'asof')
GOLD = ['must-mention', 'must-not-say', 'version-cited']
MAPPER = 'claude-haiku-5-5'
BUCKETS = ['fed', 'other ver', 'searched', 'missing', 'no passage']

# case -> one (kind, passage keys) per must-mention point, in gold order. A key picks a ground_truth_ref by
# its `location`: "=text" must equal it, anything else must be a substring of exactly one.
POINTS = {
    'vr-vrq-035-2025-10-01': [('rule', ['cl 8']), ('judgement', []), ('next step', ['65A', '91L'])],
    'vr-vrq-035-2026-02-01': [('rule', ['65B']), ('rule', ['cl 8']), ('judgement', []), ('next step', ['65A', '91L'])],
    'vr-vrq-003-2025-10-01': [('condition', ['91ZZB', '91ZZO']), ('rule', ['91ZZB']), ('rule', ['91ZZQ']), ('next step', ['91ZZQ', '91ZZS'])],
    'vr-vrq-003-2026-02-01': [('condition', ['91ZZB', '91ZZO']), ('rule', ['91ZZB']), ('rule', ['91ZZQ']), ('next step', ['91ZZQ', '91ZZS'])],
    'vr-vrq-021-2023-03-01': [('absence', ['cl 9']), ('next step', ['urgent repairs', '68A', 'term 14'])],
    'vr-vrq-021-2026-10-15': [('absence', ['cl 9']), ('rule', ['cl 9']), ('next step', ['urgent repairs', '68A', 'term 14'])],
    'vr-vrq-004-2025-10-01': [('rule', ['44(1)', 'reg 21']), ('rule', ['44(1)']), ('rule', ['44(5)']), ('next step', ['45(1)'])],
    'vr-vrq-004-2026-02-01': [('rule', ['44(1)', '=21']), ('rule', ['44(1)']), ('rule', ['44(5)']), ('next step', ['45(1)'])],
    'vr-newsq-005-2019-11-01': [('rule', ['263']), ('rule', ['266']), ('next step', ['266'])],
    'vr-newsq-005-2026-10-15': [('rule', ['91ZZO']), ('absence', ['91ZZI(3)', '91ZZI(4)']), ('next step', ['91ZZS', '330(1)', '330A'])],
    'vr-vrq-001-2026-10-15': [('rule', ['71B']), ('condition', ['71B', '71E']), ('next step', ['71B', '71E'])],
    'vr-wpq-005-2026-10-15': [('condition', ['=s 3(1): residential rental agreement', '91R']),
                              # 4 Nov 2026: the 'renter becomes the friend's landlord' and 'don't lock them out' points moved to optional credit.
                              ('rule', ['=s 81'])],
    'vr-vrq-010-2026-10-15': [('rule', ['s 62']), ('rule', ['s 61', 's 63']), ('absence', []), ('next step', ['s 62', 's 64'])],
    'vr-vrq-028-2026-10-15': [('rule', ['Regulation 14']), ('absence', ['Regulation 14']), ('rule', ['=Part 3, s 109']),
                              ('next step', ['=Part 3, s 109', '109A'])],
    'vr-newsq-008-2025-10-01': [('absence', ['30F']), ('rule', ['30F']), ('absence', ['30F']), ('absence', [])],
    'vr-newsq-008-2026-02-01': [('absence', ['30F']), ('rule', ['30F']), ('rule', ['30G']), ('absence', [])],
    # The held-out set (5 Nov 2026): one gold per slot.
    'vr-ho-vrq-011-2026-01-15': [('rule', ['=42']), ('condition', ['=21C', 'Endnotes: No. 6/2025'])],  # 5 Nov: 'who collects' point now optional
    'vr-ho-vrq-022-2019-10-15': [('rule', ['s 226']), ('rule', ['s 68', 's 72']), ('condition', ['s 226'])],
    'vr-ho-newsq-003-2025-12-03': [('rule', ['88-89']), ('rule', ['s 68AA', '85(b)', '86(1)(c)'])],  # 5 Nov: the $90-fee point now optional
    'vr-ho-wpq-008-2022-11-08': [('rule', ['s 66']), ('rule', ['s 406']), ('rule', ['s 42'])],
    'vr-ho-vrq-011-undated': [('rule', ['s 42']), ('rule', ['ss 51', 'reg 21C']), ('next step', [])],
    'vr-ho-vrq-022-undated': [('rule', ['Part 2, s 65A', 'Sch 4 cl 8']), ('rule', ['Part 2, s 91L']), ('next step', ['Part 2, s 65A'])],
    'vr-ho-vrq-020-undated': [('rule', ['Section 3(1)']), ('rule', ['Part 2, s 72']), ('rule', ['Regulation 11(e)'])],
    'vr-ho-vrq-013-undated': [('rule', ['Regulation 12']), ('rule', ['Part 2, s 63']), ('next step', [])],
    'vr-ho-vrq-027-undated': [('rule', ['ss 72AA']), ('rule', ['Current s 3(1)', 'ss 72AA']), ('rule', ['91ZD'])],
    'vr-ho-vrq-016-undated': [('rule', ['s 411,', 'ss 411AB']), ('rule', ['s 63', 'ss 411AB'])],  # 5 Nov: the s 214 point now optional
}


def norm(s):
    return re.sub(r'\s+', ' ', (s or '').replace('–', '-').replace('—', '-')).strip().lower()


def bullets(text):
    return [l[2:].strip() for l in (text or '').splitlines() if l.startswith('- ')]


class Cache:
    def __init__(self, name):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.path = CACHE_DIR / name
        self.data = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.dirty = 0

    def get(self, key):
        return self.data.get(key)

    def put(self, key, value):
        self.data[key] = value
        self.dirty += 1
        if self.dirty % 50 == 0:
            self.save()

    def save(self):
        self.path.write_text(json.dumps(self.data, indent=0))


class Onyx:
    """Cookie login as the eval user, then /document/chunk-info for chunk text."""

    def __init__(self):
        e = study.env()
        self.base = e['ONYX_BASE_URL'].rstrip('/')
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        form = urllib.parse.urlencode({'username': e['ONYX_EVAL_USER_EMAIL'], 'password': e['ONYX_EVAL_USER_PASSWORD']}).encode()
        self.op.open(urllib.request.Request(self.base + '/api/auth/login', data=form,
                                            headers={'Content-Type': 'application/x-www-form-urlencoded'}), timeout=30)
        self.cache = Cache('chunk-cache.json')

    def chunk(self, document_id, chunk_ind):
        key = f'{document_id}#{chunk_ind}'
        if (hit := self.cache.get(key)) is None:
            q = urllib.parse.urlencode({'document_id': document_id, 'chunk_id': chunk_ind})
            hit = json.loads(self.op.open(self.base + '/api/document/chunk-info?' + q, timeout=60).read())['content']
            self.cache.put(key, hit)
        return hit


class Mapper:
    """Which of the required points does the judge's reason name as missing? Cached by prompt."""

    def __init__(self):
        self.url = study.env()['JUDGE_BASE_URL'].rstrip('/') + '/chat/completions'
        self.cache = Cache('map-cache.json')

    def missing(self, points, reason):
        prompt = ('A judge failed an answer for leaving out required points. The required points were:\n\n'
                  + '\n'.join(f'{i}. {p}' for i, p in enumerate(points, 1))
                  + f'\n\nThe judge\'s reason:\n"""\n{reason}\n"""\n\n'
                  'Which points does the judge say are missing, materially wrong or too hedged? A point the judge '
                  'says is covered is not missing. Reply with only a JSON list of point numbers, such as [1, 3].')
        key = hashlib.sha1(prompt.encode()).hexdigest()
        if (hit := self.cache.get(key)) is None:
            # The model thinks before the list; 50 tokens cut it off with an empty reply.
            body = json.dumps({'model': MAPPER, 'temperature': 0, 'max_tokens': 1000,
                               'messages': [{'role': 'user', 'content': prompt}]}).encode()
            for attempt in range(3):
                try:
                    reply = json.loads(urllib.request.urlopen(urllib.request.Request(
                        self.url, data=body, headers={'content-type': 'application/json'}), timeout=120).read())
                    text = reply['choices'][0]['message']['content'] or ''
                    m = re.search(r'\[[\d,\s]*\]', text)
                    if m:
                        hit = sorted({n for n in json.loads(m.group()) if 1 <= n <= len(points)})
                        break
                except (urllib.error.URLError, KeyError, ValueError) as e:
                    if attempt == 2:
                        sys.exit(f'{MAPPER} through {self.url} failed: {e}')
            else:
                hit = []
            self.cache.put(key, hit)
        return hit


def judge_rows(path):
    """case -> {metric: {'pass': bool|None, 'reason': str}} from one promptfoo results file."""
    out = {}
    for r in json.loads(path.read_text())['results']['results']:
        comps = {}
        for c in (r.get('gradingResult') or {}).get('componentResults', []):
            metric = c.get('assertion', {}).get('metric')
            comps[metric] = {'pass': None if (c.get('metadata') or {}).get('graderError') else c['pass'],
                             'reason': c.get('reason') or ''}
        out[r['testCase']['metadata']['id']] = (r, comps)
    return out


def answers():
    """Every answer in every run, with the latest verdicts and reasons for each metric."""
    for n, root in RUNS.items():
        for cond in CONDS:
            for arm in ARMS:
                path = root / f'rentals-filters-{cond}-{arm}.json'
                if not path.exists():
                    continue
                rows = judge_rows(path)
                for over in sorted((root / 'regraded').glob(path.stem + '[.]*json')):
                    for case, (_, comps) in judge_rows(over).items():
                        if case in rows:
                            rows[case][1].update(comps)
                for case, (r, comps) in rows.items():
                    out = (r.get('response') or {}).get('output') or {}
                    out = out if isinstance(out, dict) else {}
                    fed = []
                    for call in out.get('tool_calls') or []:
                        raw = call.get('tool_result')
                        if call.get('tool_name') == 'internal_search' and isinstance(raw, str) and raw.startswith('{'):
                            fed += [(x.get('title'), norm(x.get('content'))) for x in json.loads(raw).get('results', [])]
                    searched = {}
                    for d in list(out.get('top_documents') or []) + [d for c in out.get('tool_calls') or [] for d in c.get('search_docs') or []]:
                        searched[(d['document_id'], d['chunk_ind'])] = d['semantic_identifier']
                    yield dict(run=n, cond=cond, arm=arm, case=case, md=r['testCase']['metadata'], out=out,
                               fed=fed, searched=searched, judge=comps)


def resolve(case, gold):
    """(kind, [ref dicts]) per point, checking the hand map against the compiled gold."""
    refs, points = gold['ground_truth_ref'], bullets(gold['correct_answer_summary'])
    # An undated case (cases/vic-rentals-undated.yaml) shares its dated twin's gold and points.
    spec = POINTS.get(case) or POINTS.get((gold.get('extra') or {}).get('dated_case'))
    if spec is None or len(spec) != len(points):
        sys.exit(f'{case}: POINTS has {len(spec or [])} points, the gold has {len(points)}; update the map')
    out = []
    for kind, keys in spec:
        picked = []
        for key in keys:
            hits = [x for x in refs if (x['location'] == key[1:] if key.startswith('=') else key in x['location'])]
            if len(hits) != 1:
                sys.exit(f'{case}: key {key!r} matches {len(hits)} passages')
            picked.append(hits[0])
        out.append((kind, picked))
    return out


# Lines every chunk carries (running heads, page numbers): no evidence that a passage was seen.
BOILER = re.compile(r'authorised by the chief parliamentary counsel|^residential tenancies (act 1997|regulations 2021)$'
                    r'|^no\. 109 of 1997$|^s\.r\. no\. \d+/\d+$|^part \d+-|^schedule \d+-|^\d+$')
# A passage counts as seen when at least this share of its lines is in the text.
SEEN = 0.25
_passages = {}


def passages(qid):
    """The question's law passages (questions/<qid>/question.yaml): (doc, section) -> needles, the
    passage's body lines with the margin notes cut."""
    if qid not in _passages:
        out = {}
        for p in study.passages(qid):
            lines = []
            for line in p['text'].splitlines():
                # The PDF's margin notes sit in another column, split off by a run of spaces; the body is the longest part.
                body = norm(max(re.split(r'\s{3,}', line.strip()), key=len))
                if len(body) >= 25 and not BOILER.search(body):
                    lines.append(body)
            out[(p['doc'], p['section'])] = lines
        _passages[qid] = out
    return _passages[qid]


def needles(ref, qid):
    """The passage behind a ground_truth_ref, by its document and location, else by its quote."""
    found = {k: v for k, v in passages(qid).items() if k[0] == ref['doc']}
    hits = [v for k, v in found.items() if k[1] == ref['location']]
    if len(hits) != 1:
        q = norm(ref['quote'])
        hits = [n for n in found.values() if any(q in l or l in q for l in n)]
    return hits[0] if len(hits) == 1 and hits[0] else [norm(ref['quote'])]


def coverage(lines, text):
    return sum(l in text for l in lines) / len(lines)


def locate(ref, a, qid, onyx):
    """Where the passage was: the share of its lines in each text, and the best status."""
    if a['md'].get('oracle'):  # the passage-oracle arm: every gold passage was in the message
        return 'fed', 'fed (the passage was in the message)'
    lines, quote = needles(ref, qid), norm(ref['quote'])
    texts = [' | '.join(txt for t, txt in a['fed'] if t == ref['doc']),
             ' | '.join(txt for t, txt in a['fed'] if t != ref['doc']),
             ' | '.join(norm(onyx.chunk(doc_id, ind)) for (doc_id, ind), name in a['searched'].items() if name == ref['doc'])]
    fed_right, fed_other, searched = (coverage(lines, t) for t in texts)
    # Seen: enough of the passage, or the very line the gold quotes for the point.
    seen = [c >= SEEN or quote in t for c, t in zip((fed_right, fed_other, searched), texts)]
    status = 'fed' if seen[0] else 'other ver' if seen[1] else 'searched' if seen[2] else 'missing'
    return status, f'{status} (fed {fed_right:.0%}, other version {fed_other:.0%}, searched {searched:.0%})'


def cell(n, d):
    return f'{n}/{d}' if d else '-'


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    gold = {c['id']: c for f in ('cases/vic-rentals.yaml', 'cases/vic-rentals-undated.yaml',
                                 'cases/vic-rentals-heldout.yaml', 'cases/vic-rentals-heldout-undated.yaml')
            if (ROOT / f).exists() for c in yaml.safe_load((ROOT / f).read_text())}
    spec = {case: resolve(case, g) for case, g in gold.items()}
    mapper, onyx = Mapper(), Onyx()

    rows, per_answer = [], []
    for a in answers():
        mm = a['judge'].get('must-mention', {})
        points = bullets(gold[a['case']]['correct_answer_summary'])
        dropped = set(mapper.missing(points, mm['reason'])) if mm.get('pass') is False else set()
        expected = set(a['md'].get('expected_documents') or [])
        per_answer.append(dict(
            run=a['run'], filters=a['cond'], model=a['arm'], case=a['case'], question_id=a['md'].get('question_id'),
            date=a['md'].get('scenario_date'), session=a['out'].get('chat_session_id'), docs_searched=len(a['searched']),
            chunks_fed=len(a['fed']), right_version_fed=bool(a['md'].get('oracle')) or any(t in expected for t, _ in a['fed']),
            retrieval=a['judge'].get('retrieval', {}).get('pass'),
            **{g.replace('-', '_'): a['judge'].get(g, {}).get('pass') for g in GOLD},
            gold_pass=a['judge'].get('retrieval', {}).get('pass') is True and all(a['judge'].get(g, {}).get('pass') is True for g in GOLD),
            **{g.replace('-', '_') + '_reason': a['judge'].get(g, {}).get('reason', '') for g in GOLD},
            answer=a['out'].get('answer') or ''))
        for i, (kind, refs) in enumerate(spec[a['case']], 1):
            where = {r['location']: locate(r, a, a['md']['question_id'], onyx) for r in refs} if i in dropped else {}
            bucket = (min((BUCKETS.index(w[0]) for w in where.values()), default=None) if where else None)
            rows.append(dict(run=a['run'], filters=a['cond'], model=a['arm'], case=a['case'], point=i, kind=kind,
                             judged=mm.get('pass') is not None, dropped=i in dropped,
                             bucket=BUCKETS[bucket] if bucket is not None else ('no passage' if i in dropped else ''),
                             passages='; '.join(f'{k}: {v[1]}' for k, v in where.items()),
                             reason=mm.get('reason', '') if i in dropped else ''))
    mapper.cache.save()
    onyx.cache.save()

    with (OUT_DIR / 'points.csv').open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    with (OUT_DIR / 'answers.csv').open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(per_answer[0]))
        w.writeheader()
        w.writerows(per_answer)

    judged = [r for r in rows if r['judged']]
    drops = [r for r in judged if r['dropped']]
    n_runs = len({r['run'] for r in rows})
    folders = ' '.join(str(d.relative_to(ROOT)) if d.is_relative_to(ROOT) else str(d) for d in RUNS.values())
    lines = [f"# Dropped must-mention points: {args.tag or 'baseline'}", '',
             f'Generated by `python3 scripts/dropped-points.py{" --tag " + args.tag if args.tag else ""} {folders}` '
             f'({n_runs} run folders). A point is "dropped" when the '
             f'must-mention judge failed the answer and its reason names that point ({MAPPER} reads the reason). '
             'For each dropped point, where its gold passage was: fed = given to the model from the right version; '
             'other ver = given only from another version; searched = in the search results for the right document but not '
             'given to the model; missing = not in the search results; no passage = nothing to retrieve (an absence or a '
             f'judgement call). A passage counts as present when at least {SEEN:.0%} of its lines (from the question\'s law passages) '
             'are in the text.', '',
             f'Answers: {len(per_answer)}; points judged: {len(judged)}; dropped: {len(drops)} '
             f'({100 * len(drops) / max(len(judged), 1):.0f}%).', '']

    # 1. Which points
    lines += ['## Which points get dropped', '', 'Dropped / judged, over every setup and run; then per model.', '',
              '| case | point | kind | all | ' + ' | '.join(ARMS) + ' | the point |', '|---|---|---|---|' + '---|' * len(ARMS) + '---|']
    by_point = defaultdict(list)
    for r in judged:
        by_point[(r['case'], r['point'])].append(r)
    for (case, i), rs in sorted(by_point.items(), key=lambda kv: -sum(r['dropped'] for r in kv[1]) / len(kv[1])):
        per = {arm: [r for r in rs if r['model'] == arm] for arm in ARMS}
        lines.append(f'| {case[3:]} | M{i} | {rs[0]["kind"]} | {cell(sum(r["dropped"] for r in rs), len(rs))} | '
                     + ' | '.join(cell(sum(r['dropped'] for r in per[arm]), len(per[arm])) for arm in ARMS)
                     + f' | {bullets(gold[case]["correct_answer_summary"])[i - 1]} |')

    # 2. By kind
    lines += ['', '## By kind of point', '', '| kind | points | dropped | judged | rate |', '|---|---|---|---|---|']
    for kind in ('rule', 'condition', 'next step', 'absence', 'judgement'):
        rs = [r for r in judged if r['kind'] == kind]
        if rs:
            d = sum(r['dropped'] for r in rs)
            lines.append(f'| {kind} | {len({(r["case"], r["point"]) for r in rs})} | {d} | {len(rs)} | {100 * d / len(rs):.0f}% |')

    # 3. Where the passage was
    lines += ['', '## Where the passage was, for dropped points', '', '| | ' + ' | '.join(BUCKETS) + ' | dropped |',
              '|---|' + '---|' * (len(BUCKETS) + 1)]
    groups = [('all', drops)] + [(f'model {arm}', [r for r in drops if r['model'] == arm]) for arm in ARMS] \
        + [(f'filters {c}', [r for r in drops if r['filters'] == c]) for c in CONDS]
    for name, rs in groups:
        c = Counter(r['bucket'] for r in rs)
        lines.append(f'| {name} | ' + ' | '.join(str(c.get(b, 0)) for b in BUCKETS) + f' | {len(rs)} |')
    lines += ['', 'Read: "fed" means the model had the passage and still left the point out (a writing problem); '
              '"searched" and "missing" mean it never saw it (a retrieval problem); "other ver" means it saw the text '
              'under another version, which usually carries the same words.']

    # 4. How much the model saw
    lines += ['', '## Chunks given to the model', '', 'Per answer: chunks in the search tool result, and whether any came '
              'from a document the case expects.', '', '| filters | model | answers | chunks fed, mean (min-max) | right version among them |',
              '|---|---|---|---|---|']
    for arm in ARMS:
        for cond in CONDS:
            rs = [p for p in per_answer if p['model'] == arm and p['filters'] == cond]
            if rs:
                n = [p['chunks_fed'] for p in rs]
                lines.append(f'| {cond} | {arm} | {len(rs)} | {sum(n) / len(n):.1f} ({min(n)}-{max(n)}) | '
                             f'{sum(p["right_version_fed"] for p in rs)}/{len(rs)} |')

    # 5. Every drop
    lines += ['', '## Every dropped point', '', 'run, filters, model: where each passage was; then the judge\'s reason.', '']
    for (case, i), rs in sorted(by_point.items()):
        ds = [r for r in rs if r['dropped']]
        if not ds:
            continue
        lines += [f'### {case} M{i} ({rs[0]["kind"]}): {bullets(gold[case]["correct_answer_summary"])[i - 1]}', '']
        for r in sorted(ds, key=lambda r: (r['model'], r['filters'], r['run'])):
            lines.append(f'- r{r["run"]} {r["filters"]} {r["model"]}: **{r["bucket"]}**'
                         + (f' ({r["passages"]})' if r['passages'] else '') + f'. {r["reason"][:300]}')
        lines.append('')
    OUT.write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines[:lines.index('## Every dropped point')]))
    print(f'-> {OUT.relative_to(ROOT)}, {OUT_DIR.relative_to(ROOT)}/points.csv, answers.csv')


if __name__ == '__main__':
    main()
