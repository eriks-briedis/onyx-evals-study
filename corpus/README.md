# Corpus

The library Onyx searches: 14 Authorised Versions of Victorian rental law, as published on
legislation.vic.gov.au.

- 9 versions of the Residential Tenancies Act 1997 (088, 089, 090, 097, 098, 101, 110, 111, 115).
  Several are distractors: no case cites them, they are there so that picking the version in
  force is a real test.
- 4 versions of the Residential Tenancies Regulations 2021 (002, 004, 005, 009).
- 1 version of the Residential Tenancies (Rooming House Standards) Regulations 2023 (002).

The PDFs are not in this repo (see [NOTICE](../NOTICE)). Download and check them:

```
python3 scripts/fetch-corpus.py
```

It writes `corpus/baseline/*.pdf` (what `npm run seed` uploads to Onyx) and
`corpus/extracted/*.txt` (`pdftotext -layout`, which the case compiler and the passage oracle
read). Each download must match the size and SHA-256 in the manifest.

| file | what |
|---|---|
| [manifest.yaml](manifest.yaml) | one entry per PDF: title, source URL, version, in-force dates, checksum, and the metadata Onyx stores with it (`onyx_metadata`: the document date and the in-force tags the version-filter patch reads) |
| [asof-manifest.yaml](asof-manifest.yaml) | the perfect-filter setup: one document set per scenario date, holding only the versions in force that day (`scripts/build-asof-corpora.py`) |

File names carry the version and the day it took effect, for example
`rta-1997-v110-2025-08-06.pdf` is Act version 110, in force from 6 August 2025. Onyx shows the
file name in citations, so an answer that cites a file names its version.
