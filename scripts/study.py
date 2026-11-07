"""Shared helpers for the scripts in this folder: paths, settings, the corpus, the questions'
law passages, and reading promptfoo result files.

Import it from a script in scripts/ (`import study`); Python puts the script's folder on the path.
"""
import base64
import hashlib
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / 'corpus'
QUESTIONS = ROOT / 'questions'
RESULTS = ROOT / 'results'
GOLD = ['must-mention', 'must-not-say', 'version-cited']


# --- settings ---------------------------------------------------------------------------------

def env():
    """The process environment, with .env filling in what it does not set."""
    vals = dict(os.environ)
    path = ROOT / '.env'
    if path.exists():
        for line in path.read_text().splitlines():
            m = re.match(r'^([A-Z_]+)=(.*)$', line)
            if m and m.group(1) not in vals:
                vals[m.group(1)] = m.group(2)
    return vals


def clickhouse(sql):
    """Rows of a ClickHouse query (Langfuse's trace store), FORMAT JSONEachRow."""
    e = env()
    req = urllib.request.Request(e.get('CLICKHOUSE_URL', 'http://127.0.0.1:8124'), data=sql.encode(), method='POST')
    auth = base64.b64encode(f"{e.get('CLICKHOUSE_USER', 'clickhouse')}:{e['CLICKHOUSE_PASSWORD']}".encode()).decode()
    req.add_header('Authorization', f'Basic {auth}')
    return [json.loads(line) for line in urllib.request.urlopen(req).read().decode().splitlines()]


# --- the corpus and the law passages ------------------------------------------------------------

def corpus_files():
    """The corpus manifest's file entries (corpus/manifest.yaml)."""
    return yaml.safe_load((CORPUS / 'manifest.yaml').read_text())['files']


def in_force(corpus, when):
    """Each instrument in the library with the title of its version in force on `when`, or a
    note that none is."""
    lines = []
    for inst in dict.fromkeys(f['title'].split(', Authorised')[0] for f in corpus):
        live = [f for f in corpus if f['title'].startswith(inst + ',')
                and f['in_force_from'] <= when and (f['in_force_to'] is None or when <= f['in_force_to'])]
        lines.append(live[0]['title'] if live else f'{inst}: no version in the library was in force on this date')
    return lines


_TEXT = {}


def corpus_text(name):
    """The pdftotext layout text of a corpus PDF (corpus/extracted/<stem>.txt)."""
    stem = Path(name).stem
    if stem not in _TEXT:
        path = CORPUS / 'extracted' / f'{stem}.txt'
        if not path.exists():
            sys.exit(f'{path.relative_to(ROOT)} missing: run scripts/fetch-corpus.py first')
        _TEXT[stem] = path.read_text()
    return _TEXT[stem]


def question(qid):
    """questions/<qid>/question.yaml."""
    return yaml.safe_load((QUESTIONS / qid / 'question.yaml').read_text())


def passage_text(p):
    """A passage's text, cut from the corpus text and checked against its recorded hash."""
    quote = corpus_text(p['doc'])[p['start']:p['end']]
    if hashlib.sha256(quote.encode()).hexdigest() != p['sha256']:
        sys.exit(f"{p['doc']} {p['section']!r}: the text at {p['start']}-{p['end']} is not the recorded passage. "
                 'A different pdftotext version may lay the text out differently.')
    return quote


def passages(qid):
    """The question's law passages: dicts with doc, section and text."""
    return [dict(doc=p['doc'], section=p['section'], text=passage_text(p)) for p in question(qid)['passages']]


# --- promptfoo results ---------------------------------------------------------------------------

def verdicts(r):
    """metric -> pass, or None where the judge reply could not be parsed (no verdict, not a fail)."""
    return {c.get('assertion', {}).get('metric'): None if (c.get('metadata') or {}).get('graderError') else c['pass']
            for c in (r.get('gradingResult') or {}).get('componentResults', [])}


def judge_of(doc):
    return re.sub(r'.*judge=', '', doc.get('config', {}).get('description', ''))


# (cond, arm) -> how the run was judged, filled in by load().
JUDGED = {}


def load(cond, arm, root=RESULTS):
    """One run's rows from results/<root>/rentals-filters-<cond>-<arm>.json, or None.

    root is results/ (run 1), results/repeats/r<N> or results/variants/<setup>/r<N>. Each
    re-judge in <root>/regraded/ (promptfooconfig.regrade.yaml) overlays the verdicts it redid."""
    name = f'rentals-filters-{cond}-{arm}.json'
    if not (root / name).exists():
        return None
    doc = json.loads((root / name).read_text())
    JUDGED[(cond, arm)] = 'original, ' + judge_of(doc)
    redone = defaultdict(dict)
    for path in sorted((root / 'regraded').glob(name.removesuffix('.json') + '[.]*json')):
        re_doc = json.loads(path.read_text())
        part = {r['testCase']['metadata']['id']: verdicts(r) for r in re_doc['results']['results']}
        for case, v in part.items():
            redone[case].update(v)
        rubrics = sorted({m for v in part.values() for m in v if m in GOLD + ['unsupported-claim']})
        JUDGED[(cond, arm)] += f"; re-judged {', '.join(rubrics)}, {judge_of(re_doc)}"
    rows = []
    for r in doc['results']['results']:
        out = r.get('response', {}).get('output') or {}
        if not isinstance(out, dict):
            out = {}
        md = r['testCase'].get('metadata', {})
        metrics = {**verdicts(r), **redone.get(md.get('id'), {})}
        rows.append(dict(
            case=md.get('id'), qid=md.get('question_id'), date=md.get('scenario_date'),
            session=out.get('chat_session_id'), docs=len(out.get('top_documents') or []),
            latency=r.get('latencyMs'), error=out.get('error_msg') or r.get('response', {}).get('error'),
            metrics=metrics))
    return rows


def ok(m, key):
    return m.get(key) is True
