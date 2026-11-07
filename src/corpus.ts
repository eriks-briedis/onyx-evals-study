/**
 * The eval corpus as the seed script and the setup hook both see it.
 *
 * `corpus/manifest.yaml` is the record of what each file is. This module reads the
 * entries for one doc set, checks them against the bytes on disk, and derives the Onyx
 * connector name from their checksums. That name is the whole identity scheme: an
 * unchanged corpus maps to the connector that is already indexed, and any edit maps to a
 * new one.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { parse } from 'yaml';

export interface CorpusFile {
  /** Relative to the corpus manifest's directory, e.g. `baseline/rta-1997-v110-2025-08-06.pdf`. */
  path: string;
  sha256: string;
  bytes: number;
  /**
   * Per-file Onyx metadata (doc_updated_at, link, ...), seeded through the file connector's
   * `.onyx_metadata.json`. Absent for corpora that do not set any.
   */
  onyxMetadata?: Record<string, unknown>;
}

export interface Corpus {
  corpusId: string;
  docSet: string;
  /** Directory the file paths are relative to. */
  root: string;
  files: CorpusFile[];
  /** Every connector this suite seeds for the doc set starts with this. */
  connectorPrefix: string;
  connectorName: string;
}

interface ManifestYaml {
  corpus_id?: string;
  files?: {
    path: string;
    doc_set?: string;
    sha256: string;
    bytes: number;
    onyx_metadata?: Record<string, unknown>;
  }[];
}

export function connectorPrefix(docSet: string): string {
  return `onyx-evals:${docSet}:`;
}

/**
 * Hashes path and checksum together, so a rename is a corpus change too, and so is any change
 * to a file's Onyx metadata (it alters what is indexed). Twelve hex characters is plenty to
 * tell a handful of corpus versions apart.
 */
export function connectorName(docSet: string, files: CorpusFile[]): string {
  const lines = files
    .map((f) => `${f.path}\t${f.sha256}${f.onyxMetadata ? `\t${stableJson(f.onyxMetadata)}` : ''}\n`)
    .sort()
    .join('');
  const digest = createHash('sha256').update(lines).digest('hex').slice(0, 12);
  return `${connectorPrefix(docSet)}${digest}`;
}

export function loadCorpus(manifestPath: string, docSet: string): Corpus {
  const doc = parse(readFileSync(manifestPath, 'utf8')) as ManifestYaml;
  const files = (doc.files ?? [])
    .filter((f) => f.doc_set === docSet)
    .map((f) => ({
      path: f.path,
      sha256: f.sha256,
      bytes: f.bytes,
      ...(f.onyx_metadata ? { onyxMetadata: f.onyx_metadata } : {}),
    }));
  if (files.length === 0) {
    throw new Error(`${manifestPath} lists no files for doc_set ${docSet}.`);
  }

  // The file connector uses the basename as semantic_identifier, and the retrieval
  // asserts match on it. Two files with one name would be indistinguishable.
  const seen = new Map<string, string>();
  for (const f of files) {
    const name = basename(f.path);
    const other = seen.get(name);
    if (other) throw new Error(`Two ${docSet} files share the name ${name}: ${other} and ${f.path}`);
    seen.set(name, f.path);
  }

  return {
    corpusId: doc.corpus_id ?? 'unknown',
    docSet,
    root: dirname(manifestPath),
    files,
    connectorPrefix: connectorPrefix(docSet),
    connectorName: connectorName(docSet, files),
  };
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

/** The `.onyx_metadata.json` body for a corpus, keyed by file name; null when no file sets any. */
export function onyxMetadataFile(corpus: Corpus): Record<string, Record<string, unknown>> | null {
  const entries = corpus.files
    .filter((f) => f.onyxMetadata)
    .map((f) => [basename(f.path), f.onyxMetadata as Record<string, unknown>] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** Returns one line per file whose bytes do not match the manifest. Empty means clean. */
export function checksumProblems(corpus: Corpus): string[] {
  const problems: string[] = [];
  for (const f of corpus.files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(corpus.root, f.path));
    } catch {
      problems.push(`${f.path}: missing`);
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== f.sha256) problems.push(`${f.path}: sha256 ${actual}, manifest says ${f.sha256}`);
  }
  return problems;
}
