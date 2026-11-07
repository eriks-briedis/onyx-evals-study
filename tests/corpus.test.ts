/**
 * Offline test: the corpus the seed script uploads. Needs no Onyx.
 *
 * The connector name is the seed script's only record of which corpus is indexed, so it
 * must be stable for unchanged files and move when any file does.
 */
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { describe, it } from 'node:test';

import { checksumProblems, connectorName } from '../src/corpus.js';
import { loadManifest, loadManifestCorpus } from '../src/setup.js';

describe('corpus', () => {
  const corpus = loadManifestCorpus(loadManifest());

  it('selects the 14 vic-rentals-baseline files, all under baseline/', () => {
    assert.equal(corpus.docSet, 'vic-rentals-baseline');
    assert.equal(corpus.files.length, 14);
    assert.ok(corpus.files.every((f) => f.path.startsWith('baseline/')));
  });

  // Needs the PDFs: python3 scripts/fetch-corpus.py.
  it('matches the checksums in the corpus manifest', () => {
    assert.deepEqual(checksumProblems(corpus), []);
  });

  it('holds every Act version the cases name, one file per version', () => {
    const names = corpus.files.map((f) => basename(f.path));
    for (const v of ['088', '101', '110', '111', '115']) {
      assert.equal(names.filter((n) => n.startsWith(`rta-1997-v${v}-`)).length, 1, `Act version ${v}`);
    }
  });

  it('names the connector from the checksums, independent of file order', () => {
    assert.match(corpus.connectorName, /^onyx-evals:vic-rentals-baseline:[0-9a-f]{12}$/);
    assert.equal(connectorName(corpus.docSet, [...corpus.files].reverse()), corpus.connectorName);
  });

  it('names a different connector when any file changes or moves', () => {
    const [first, ...rest] = corpus.files;
    assert.ok(first);
    const edited = [{ ...first, sha256: '0'.repeat(64) }, ...rest];
    const moved = [{ ...first, path: `${first.path}.moved` }, ...rest];
    assert.notEqual(connectorName(corpus.docSet, edited), corpus.connectorName);
    assert.notEqual(connectorName(corpus.docSet, moved), corpus.connectorName);
    assert.notEqual(connectorName(corpus.docSet, rest), corpus.connectorName);
  });
});
