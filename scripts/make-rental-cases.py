#!/usr/bin/env python3
"""Compile the gold in questions/<ID>/ into the eval cases under cases/.

Each question folder holds the gold a person wrote (README.md: role, question, and one
"## Gold — ..." section per scenario date) and a machine record (question.yaml: main or
held-out set, and where each law passage sits in the corpus text). One case per gold slot
(question x scenario date). The pass/fail rule becomes three judge questions: must-mention,
must-not-say and version-cited.

Writes:
  cases/vic-rentals.yaml                 main set, dated slots (16)
  cases/vic-rentals-undated.yaml         main set: the dated slots whose law is the law in force on
                                         UNDATED_AS_AT, with the date sentence cut from the question (6)
  cases/vic-rentals-heldout.yaml         held-out set, dated slots (4)
  cases/vic-rentals-heldout-undated.yaml held-out set, undated slots (6)

Needs the corpus text: run scripts/fetch-corpus.py first. Then `npm run cases` compiles these
into datasets/ for promptfoo.
"""
import re
from datetime import date
from pathlib import Path

import yaml

import study
from study import corpus_text, in_force, passage_text

ROOT, QUESTIONS = study.ROOT, study.QUESTIONS
DOC_SET = 'vic-rentals-baseline'
# The day the main set's undated copies are answered as at (the undated runs were made on
# 4 Nov 2026). Fixed rather than "today": once Victoria publishes a newer version of the Act or
# the Regulations, the undated gold describes the law of this day, not of the day you run it.
UNDATED_AS_AT = '2026-11-04'
# Case order in the files: the order the questions were chosen in.
ORDER = ['VRQ-035', 'VRQ-003', 'VRQ-021', 'VRQ-004', 'NEWSQ-005', 'VRQ-001', 'WPQ-005', 'VRQ-010', 'VRQ-028', 'NEWSQ-008',
         'VRQ-011', 'VRQ-022', 'NEWSQ-003', 'WPQ-008', 'VRQ-020', 'VRQ-013', 'VRQ-027', 'VRQ-016']
# unsupported-claim is left out: it sends the judge the whole search result (~42k tokens a
# call, about 88% of judge spend) and the pass/fail rule does not use it.
JUDGE = ['must-mention', 'must-not-say', 'version-cited']
# Running headers and footers repeat on every page, so they ground nothing.
BOILERPLATE = re.compile(r'^(Authorised by the Chief Parliamentary Counsel|Part \d+[A-Z]?—|Schedule \d|Residential Tenancies|'
                         r'No\. 109 of 1997|S\.R\. No\.|S\. \d|inserted by|amended by|substituted by|No\. \d+/\d{4}|\d+$)')
DATE_SENTENCE = re.compile(r'^It is \d{1,2} [A-Z][a-z]+ \d{4}\.\s*')


class NoAliases(yaml.SafeDumper):
    """Write repeated lists out in full: `&id001` / `*id001` markers are hard to read."""

    def ignore_aliases(self, data):
        return True


# In-force files that print, at the back under "Amendments Not in Operation", amendments passed but
# not yet law. Only v088 and v089 of the Act do (later versions say they contain none), and the
# rules named below occur there and not in the body; check_not_in_operation() re-checks the first
# part against the extracted text. The note reaches the version-cited rubric (src/cases.ts
# notInOperation): without it the judge passed answers that applied the 2018 reforms as 2019 law
# because they cited v088 (results/hand-check/score3.md).
_RTA_2018 = ('the Residential Tenancies Amendment Act 2018 (No. 45/2018) and related 2019 amendments, '
             'most of which commenced on 29 March 2021. They include the rental minimum standards, mould or '
             'damp caused by or related to the building structure as an urgent repair, and new sections '
             'such as ss 91ZK, 91ZX-91ZZD and 91ZZI. Using their terms ("renter", "rental provider") is not '
             'by itself applying their rules')
NOT_IN_OPERATION = {
    'Residential Tenancies Act 1997, Authorised Version No. 088': _RTA_2018,
    'Residential Tenancies Act 1997, Authorised Version No. 089': _RTA_2018,
}
NONE_PENDING = 'does not contain amendments that are not yet in operation'


def check_not_in_operation(corpus):
    """Every file whose text prints pending amendments is in NOT_IN_OPERATION, and no other."""
    for f in corpus:
        text = corpus_text(f['path'])
        pending = 'Amendments Not in Operation' in text and NONE_PENDING not in text
        assert pending == (f['title'] in NOT_IN_OPERATION), (f['title'], 'NOT_IN_OPERATION is out of date')


def section(md, start, stops=('**', '## ')):
    """Text after the bold label `start` up to the next bold label or heading."""
    i = md.index(start) + len(start)
    j = min([k for k in (md.find(s, i) for s in stops) if k >= 0] + [len(md)])
    return md[i:j].strip()


def bullets(text):
    return [line[2:].strip() for line in text.splitlines() if line.startswith('- ') and line[2:].strip()]


def heading_body(md, heading):
    """The text under `## heading`, up to the next `## `."""
    return re.search(rf'^## {re.escape(heading)}\n(.*?)(?=^## |\Z)', md, re.M | re.S).group(1).strip()


def gold_slots(md):
    for block in re.split(r'^## Gold — (?:scenario date )?', md, flags=re.M)[1:]:
        when = block.split('\n', 1)[0].strip()
        must_not = bullets(section(block, '**Must not say:**'))
        yield dict(
            date=when,
            asked=section(block, '**Question as asked:**') if '**Question as asked:**' in block else None,
            status=re.search(r'^Status: (.+)$', block, re.M).group(1),
            must_cite=bullets(section(block, '**Must cite (version in force on this date):**')),
            answer=section(block, '**Correct answer (short):**'),
            must_mention=bullets(section(block, '**Must mention:**')),
            optional=bullets(section(block, '**Optional (credit, not required):**')) if '**Optional' in block else [],
            # Naming a wrong version is graded by version-cited, not here.
            must_not_say=[m for m in must_not if not m.lower().startswith('a wrong version')],
        )


def version_tokens(version):
    n = int(version)
    return [version, f'version {n}', f'version no. {n}', f'v{n}']


def anchor(p):
    """A run of text from one line of the passage, without the margin notes pdftotext lays out
    beside it: the longest that occurs only once in the document, so it pins the passage
    rather than any page."""
    text = corpus_text(p['doc'])
    pieces = [seg.strip() for line in passage_text(p).splitlines() for seg in re.split(r'\s{3,}', line)]
    pieces = [x for x in pieces if len(x) >= 25 and not BOILERPLATE.match(x)]
    pieces.sort(key=lambda x: (text.count(x) != 1, -len(x)))
    assert pieces and pieces[0] in text, (p['doc'], p['section'], 'no usable quote line')
    return pieces[0]


def load_questions():
    """Every questions/<ID>/ folder, in ORDER."""
    out = []
    for folder in sorted(QUESTIONS.iterdir()):
        if not folder.is_dir():
            continue
        rec = yaml.safe_load((folder / 'question.yaml').read_text())
        md = (folder / 'README.md').read_text()
        assert rec['id'] == folder.name, folder
        rec['role'] = re.search(r'^\*\*Role:\*\* (.+?)\s*$', md, re.M).group(1)
        rec['question'] = heading_body(md, 'Question').split('\n\n')[0]  # the paragraph before **Boundary:**
        rec['md'] = md
        out.append(rec)
    return sorted(out, key=lambda q: ORDER.index(q['id']))


def compile_question(q, corpus, by_title):
    heldout = q['set'] == 'held-out'
    for slot in gold_slots(q['md']):
        assert slot['status'].startswith('approved'), (q['id'], slot['date'], slot['status'])
        undated = slot['date'] == 'undated'
        as_at = q['undated_as_at'] if undated else slot['date']
        cited = []
        for line in slot['must_cite']:
            title = re.match(r'(.*?Authorised Version No\. \d+)', line).group(1)
            assert title in by_title, (q['id'], title, 'not in the corpus manifest')
            cited.append(by_title[title])
        live = in_force(corpus, as_at)
        assert all(f['title'] in live for f in cited), (q['id'], slot['date'], 'must-cite version not in force')
        cited_paths = {f['path'] for f in cited}
        cited_names = {Path(f['path']).name for f in cited}
        instruments = {f['title'].split(', Authorised')[0] for f in cited}
        refs = [dict(doc=p['doc'], location=p['section'], quote=anchor(p))
                for p in q['passages'] if p['doc'] in cited_names]
        assert refs, (q['id'], slot['date'], 'no ground-truth passage from a cited version')

        if slot['asked']:
            question = slot['asked']
        else:
            when = date.fromisoformat(slot['date'])
            question = f"It is {when.day} {when.strftime('%B %Y')}. {q['question']}"
        yield dict(
            id=f"vr-{'ho-' if heldout else ''}{q['id'].lower()}-{slot['date']}",
            category=re.sub(r'[^a-z]+', '-', q['role'].lower()).strip('-'),
            question=question,
            document_set=DOC_SET,
            expected_documents=[Path(f['path']).name for f in cited],
            expected_not_cited=sorted(Path(f['path']).name for f in corpus
                                      if f['title'].split(', Authorised')[0] in instruments
                                      and f['path'] not in cited_paths),
            expects_citations=True,
            must_contain=[[t for f in cited for t in version_tokens(f['version'])]],
            must_not_contain=[],
            judge_questions=JUDGE,
            ground_truth_ref=refs,
            correct_answer_summary='\n'.join(f'- {m}' for m in slot['must_mention']),
            wrong_answer_looks_like='\n'.join(f'- {m}' for m in slot['must_not_say'])
            or '- (Nothing beyond naming a wrong version, which version-cited grades.)',
            must_cite=slot['must_cite'],
            # The date lets the judge accept a version named by its date ("the version dated 6 August 2025").
            in_force=[f"{l}, dated {date.fromisoformat(by_title[l]['in_force_from']):%-d %B %Y}" if l in by_title else l
                      for l in live],
            **(dict(not_in_operation=[f'{l}: {NOT_IN_OPERATION[l]}' for l in live if l in NOT_IN_OPERATION])
               if any(l in NOT_IN_OPERATION for l in live) else {}),
            extra=dict(question_id=q['id'], scenario_date=slot['date'], role=q['role'],
                       gold_answer=slot['answer'], optional_credit=slot['optional'],
                       **(dict(heldout=True) if heldout else {}),
                       **(dict(undated=True, gold_date=as_at) if undated else {})),
        )


def mark_quick(cases):
    """The quick subset (--filter-metadata quick=true) asks each question once, on its earliest
    date: 10 cases instead of 16, for iterating before a full run."""
    first = {}
    for c in cases:
        q = c['extra']['question_id']
        if q not in first or c['extra']['scenario_date'] < first[q]['extra']['scenario_date']:
            first[q] = c
    for c in cases:
        c['extra']['quick'] = c is first[c['extra']['question_id']]


def undated_copies(cases, corpus):
    """The dated cases whose law is the law in force on UNDATED_AS_AT, asked without a date. Their
    gold is already right for that day, so only the question changes."""
    current = in_force(corpus, UNDATED_AS_AT)
    out = []
    for c in cases:
        when = c['extra']['scenario_date']
        if in_force(corpus, when) != current:
            continue
        q = DATE_SENTENCE.sub('', c['question'])
        assert q != c['question'], (c['id'], 'no date sentence found')
        out.append(dict(c, id=re.sub(r'-\d{4}-\d{2}-\d{2}$', '-undated', c['id']), question=q,
                        extra={**c['extra'], 'scenario_date': 'undated', 'dated_case': c['id'],
                               'gold_date': when, 'undated': True, 'quick': True}))
    assert out, f'no case shares the in-force window of {UNDATED_AS_AT}'
    return out


def write(path, cases, note):
    path.write_text(
        f'# GENERATED by scripts/make-rental-cases.py from questions/*/ ({note}).\n'
        '# Do not edit: edit questions/<ID>/README.md and re-run. Fields: cases/README.md.\n'
        + yaml.dump(cases, Dumper=NoAliases, sort_keys=False, allow_unicode=True, width=100))
    print(f'{len(cases):2} cases -> {path.relative_to(ROOT)}')


def write_index(questions, cases):
    """questions/README.md: one row per question, with its cases."""
    by_q = {}
    for c in cases:
        by_q.setdefault(c['extra']['question_id'], []).append(c['id'])
    lines = ['# The questions', '',
             'Generated by scripts/make-rental-cases.py. One folder per question: README.md holds the gold '
             '(what a correct answer must mention, must not say, and which law version it must cite, for each '
             'date the question is asked on); question.yaml says where each law passage sits in the corpus.', '',
             'The main set (10) is what the study was developed on. The held-out set (8) was chosen, and its gold '
             'written, after the fix was frozen. A question asked on two dates straddles a change in the law; '
             '"undated" means asked with no date, so the law in force when it was asked (4-5 November 2026) applies.', '',
             '| question | set | role | asked | cases |', '|---|---|---|---|---|']
    for q in questions:
        dates = [cid.split(q['id'].lower() + '-', 1)[1] for cid in by_q[q['id']]]
        text = q['question'] if len(q['question']) <= 110 else q['question'][:107].rsplit(' ', 1)[0] + ' ...'
        lines.append(f"| [{q['id']}]({q['id']}/README.md): {text} | {q['set']} | {q['role']} | "
                     f"{', '.join(dates)} | {', '.join(f'`{c}`' for c in by_q[q['id']])} |")
    (QUESTIONS / 'README.md').write_text('\n'.join(lines) + '\n')
    print(f'{len(questions):2} questions -> questions/README.md')


def main():
    corpus = study.corpus_files()
    check_not_in_operation(corpus)
    by_title = {f['title']: f for f in corpus}
    questions = load_questions()
    main_cases = [c for q in questions if q['set'] == 'main' for c in compile_question(q, corpus, by_title)]
    held = [c for q in questions if q['set'] == 'held-out' for c in compile_question(q, corpus, by_title)]
    mark_quick(main_cases)
    mark_quick(held)
    undated = undated_copies(main_cases, corpus)
    write(ROOT / 'cases/vic-rentals.yaml', main_cases, 'main set, dated')
    write(ROOT / 'cases/vic-rentals-undated.yaml', undated,
          f'main set: the dated slots in force on {UNDATED_AS_AT}, asked without a date')
    write(ROOT / 'cases/vic-rentals-heldout.yaml', [c for c in held if not c['extra'].get('undated')], 'held-out set, dated')
    write(ROOT / 'cases/vic-rentals-heldout-undated.yaml', [c for c in held if c['extra'].get('undated')],
          'held-out set, undated')
    write_index(questions, main_cases + undated + held)


if __name__ == '__main__':
    main()
