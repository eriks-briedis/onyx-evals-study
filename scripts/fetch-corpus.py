#!/usr/bin/env python3
"""Download the 14 law PDFs the study indexes in Onyx, check them, and extract their text.

The PDFs are Authorised Versions from legislation.vic.gov.au. They are not in this repo: the
State of Victoria holds their copyright and publishes them for personal use (see NOTICE).
corpus/manifest.yaml records each file's source URL, size and SHA-256; a download that does
not match is refused, so every reader indexes the exact bytes the study used.

Writes corpus/baseline/<file>.pdf (what `npm run seed` uploads) and corpus/extracted/<file>.txt
(`pdftotext -layout`, which the case compiler and the passage oracle read). Files already
present with the right hash are kept.

  python3 scripts/fetch-corpus.py
"""
import hashlib
import subprocess
import sys
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / 'corpus'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'onyx-evals-study corpus fetch'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main():
    files = yaml.safe_load((CORPUS / 'manifest.yaml').read_text())['files']
    (CORPUS / 'extracted').mkdir(parents=True, exist_ok=True)
    bad = 0
    for f in files:
        pdf = CORPUS / f['path']
        pdf.parent.mkdir(parents=True, exist_ok=True)
        if not (pdf.exists() and sha256(pdf.read_bytes()) == f['sha256']):
            data = fetch(f['source_url'])
            if sha256(data) != f['sha256'] or len(data) != f['bytes']:
                print(f"MISMATCH {pdf.name}: got {len(data)} bytes, sha256 {sha256(data)[:12]}; "
                      f"expected {f['bytes']} bytes, {f['sha256'][:12]}", file=sys.stderr)
                bad += 1
                continue
            pdf.write_bytes(data)
        txt = CORPUS / 'extracted' / (pdf.stem + '.txt')
        subprocess.run(['pdftotext', '-layout', str(pdf), str(txt)], check=True)
        print(f"ok  {pdf.relative_to(ROOT)}  {f['bytes'] // 1024} KB")
    if bad:
        sys.exit(f'{bad} file(s) did not match the manifest; the source may have been replaced')


if __name__ == '__main__':
    main()
