#!/usr/bin/env python3
"""Write the full text of every question's law passages to build/passages/<ID>.md, to read alongside
questions/<ID>/README.md.

The repo records only where each passage sits (questions/<ID>/question.yaml); the text is cut from
the official PDFs you download with scripts/fetch-corpus.py, because the State of Victoria holds
its copyright (see NOTICE). build/ is not committed.

  python3 scripts/build-passages.py
"""
from pathlib import PurePosixPath

import study

OUT = study.ROOT / 'build/passages'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    files = {PurePosixPath(f['path']).name: f for f in study.corpus_files()}
    for folder in sorted(p for p in study.QUESTIONS.iterdir() if p.is_dir()):
        qid = folder.name
        rec = study.question(qid)
        lines = [f'# {qid}: law passages', '',
                 f'Cut from the corpus text (pdftotext -layout) at the offsets in questions/{qid}/question.yaml.', '']
        for p, raw in zip(study.passages(qid), rec['passages']):
            f = files[p['doc']]
            lines += [f"## {f['title']}: {p['section']}", '',
                      f"`{p['doc']}`, PDF page {raw['pdf_page']}: {f['source_url']}#page={raw['pdf_page']}", '',
                      '```', p['text'].rstrip('\n'), '```', '']
        (OUT / f'{qid}.md').write_text('\n'.join(lines))
    print(f'{OUT.relative_to(study.ROOT)}/: one file per question')


if __name__ == '__main__':
    main()
