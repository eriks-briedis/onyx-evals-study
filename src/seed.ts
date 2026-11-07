/**
 * Seed the corpus into Onyx: `npm run seed`. Run it before `npm run eval`.
 *
 * One file connector holds every file of the doc set, named for the corpus checksums
 * (see corpus.ts). An unchanged corpus finds its connector already indexed and does
 * nothing. An edited corpus gets a new connector, the document set moves to it once it is
 * fully indexed, and only then are older seeded connectors deleted — so the old corpus
 * keeps serving until the new one is ready.
 *
 * Files go through the file connector rather than the ingestion API because PDF
 * extraction is part of the system under test.
 *
 * `npm run seed -- --reindex` re-indexes an existing corpus from the beginning. The
 * connector name only tracks the files, so after changing how Onyx indexes (a model, a
 * setting) this is the way to rebuild the index for the same files.
 *
 * Which corpus: `--corpus <doc_set>` if given, else `EVAL_CORPUS`, else manifest.corpus.
 * `npm run seed` sets EVAL_CORPUS=vic-rentals-baseline, like the eval scripts; the perfect-filter
 * arm's per-date sets are `npm run seed -- --corpus vic-rentals-asof-<date>`.
 */
import { spawnSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import { type Corpus, checksumProblems, onyxMetadataFile } from './corpus.js';
import { OnyxClient, OnyxError, pollUntil } from './onyx.js';
import {
  checkEvalModel,
  checkIndexingSettings,
  checkReachability,
  clientFromEnv,
  loadManifest,
  corpusRef,
  loadManifestCorpus,
} from './setup.js';
import type { CcPairInfo, FileUploadResponse, Manifest } from './types.js';

const POLL_MS = 15_000;
const INDEXING_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
/** Full re-index attempts after the first, when documents or chunk contexts fail. */
const MAX_REINDEXES = 2;
const TERMINAL = new Set(['success', 'completed_with_errors', 'failed', 'canceled']);

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};

function log(message: string): void {
  console.log(`[seed ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function findSeededPair(onyx: OnyxClient, name: string): Promise<number | undefined> {
  const matches = (await onyx.getIndexingStatuses())
    .filter((s) => s.name === name)
    .map((s) => s.cc_pair_id)
    .sort((a, b) => a - b);
  if (matches.length > 1) log(`warning: ${matches.length} connectors named ${name}; using cc_pair ${matches[0]}`);
  return matches[0];
}

/** A one-entry zip, stored without compression: all the file connector's metadata upload needs. */
function storedZip(name: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

async function createSeededPair(onyx: OnyxClient, corpus: Corpus): Promise<number> {
  // One upload per file keeps each request small; the 7 MB PDF is the largest.
  const uploaded: FileUploadResponse = { file_paths: [], file_names: [], zip_metadata_file_id: null };
  for (const [i, f] of corpus.files.entries()) {
    const name = basename(f.path);
    const type = CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
    const res = await onyx.uploadConnectorFile(name, readFileSync(resolve(corpus.root, f.path)), type);
    uploaded.file_paths.push(...res.file_paths);
    uploaded.file_names.push(...res.file_names);
    if ((i + 1) % 10 === 0 || i + 1 === corpus.files.length) log(`uploaded ${i + 1}/${corpus.files.length} files`);
  }

  const metadata = onyxMetadataFile(corpus);
  if (metadata) {
    const zip = storedZip('.onyx_metadata.json', Buffer.from(JSON.stringify(metadata, null, 2)));
    const res = await onyx.uploadConnectorZip('onyx-metadata.zip', zip);
    if (!res.zip_metadata_file_id || res.file_paths.length > 0) {
      throw new Error(
        `Metadata upload returned zip_metadata_file_id=${res.zip_metadata_file_id} and ` +
          `${res.file_paths.length} file(s); expected an id and none.`,
      );
    }
    uploaded.zip_metadata_file_id = res.zip_metadata_file_id;
    log(`uploaded .onyx_metadata.json for ${Object.keys(metadata).length} files`);
  }

  const connector = await onyx.createFileConnector(corpus.connectorName, uploaded);
  const credential = await onyx.createFileCredential(corpus.connectorName);
  const ccPairId = await onyx.linkCredential(connector.id, credential.id, corpus.connectorName);
  log(`created ${corpus.connectorName}: connector ${connector.id}, cc_pair ${ccPairId}`);
  return ccPairId;
}

/**
 * Counts contextual RAG failures in the Onyx background worker's log since `since`.
 *
 * Onyx catches these (indexing_pipeline.py add_chunk_summaries), stores the chunk with an
 * empty context and still counts the document as indexed, so no API reports them. Indexing
 * traces do not reach Langfuse either. The log is the only place they show up.
 */
function chunkContextFailures(since: Date): number {
  const text = dockerBackground(['logs', '--since', since.toISOString()]);
  if (text === undefined) return 0;
  return (text.match(/(Error|Rate limit) adding chunk summary/g) ?? []).length;
}

const skipDockerChecks = () => process.env.ONYX_SKIP_DOCKER_CHECKS === '1';

/**
 * Runs `docker <args> <background container>` and returns stdout plus stderr, or undefined
 * when docker checks are switched off. The HTTP API exposes neither the worker's log nor
 * its environment, and both decide what indexing stores.
 */
function dockerBackground(args: string[], extra: string[] = []): string | undefined {
  if (skipDockerChecks()) return undefined;
  const container = process.env.ONYX_BACKGROUND_CONTAINER ?? 'onyx-background-1';
  const res = spawnSync('docker', [...args, container, ...extra], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `docker ${args[0]} ${container} failed: ${res.error?.message ?? res.stderr.trim()}\n` +
        'Set ONYX_BACKGROUND_CONTAINER to the Onyx background container, or ' +
        'ONYX_SKIP_DOCKER_CHECKS=1 to skip the checks that need it.',
    );
  }
  return `${res.stdout}${res.stderr}`;
}

/** The Onyx environment variables the manifest pins, read from the running worker. */
function checkBackgroundEnv(manifest: Manifest): void {
  const want = manifest.onyx_background_env;
  const names = Object.keys(want);
  // `env`, not `printenv NAME...`: printenv exits non-zero when a name is unset.
  const out = dockerBackground(['exec'], ['env']);
  if (out === undefined) {
    log('warning: ONYX_SKIP_DOCKER_CHECKS=1, not checking the Onyx background environment or log');
    return;
  }
  const env = new Map(
    out
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );
  const problems = names
    .filter((name) => env.get(name) !== want[name])
    .map((name) => `  - ${name} is ${env.has(name) ? JSON.stringify(env.get(name)) : 'unset'}, manifest pins ${JSON.stringify(want[name])}`);
  if (problems.length > 0) {
    throw new Error(
      `Onyx background environment drift against manifest/manifest.json:\n${problems.join('\n')}\n` +
        'Set these in deployment/docker_compose/.env and recreate only that service:\n' +
        '  docker compose up -d --force-recreate --no-deps background',
    );
  }
}

/**
 * Waits until every document is indexed with no failed chunk contexts, re-indexing from
 * the beginning when an attempt finishes short. Returns immediately for a corpus that was
 * already fully indexed before this run, unless `reindexFirst` asks for a rebuild.
 */
async function waitForIndexing(
  onyx: OnyxClient,
  ccPairId: number,
  expected: number,
  reindexFirst: boolean,
): Promise<CcPairInfo> {
  const started = Date.now();
  const deadline = started + INDEXING_TIMEOUT_MS;
  // Only an attempt newer than this can settle the wait, so after a re-index is requested
  // the previous attempt's result is never read again.
  let afterAttempt = -1;
  // Whether this run saw indexing happen. A corpus that was already indexed is not
  // re-checked for failed chunk contexts; that was done when it was indexed.
  let sawIndexing = false;
  let reindexes = 0;
  let lastLine = '';
  let lastLogAt = 0;

  if (reindexFirst) {
    const [info, attempts] = await Promise.all([onyx.getCcPair(ccPairId), onyx.listIndexAttempts(ccPairId)]);
    afterAttempt = attempts[0]?.id ?? -1;
    sawIndexing = true;
    log(`--reindex: re-indexing cc_pair ${ccPairId} from the beginning`);
    await onyx.runConnectorOnce(info.connector.id, info.credential.id, true);
  }

  for (;;) {
    const [info, attempts] = await Promise.all([onyx.getCcPair(ccPairId), onyx.listIndexAttempts(ccPairId)]);
    const attempt = attempts[0];
    const terminal = TERMINAL.has(attempt?.status ?? '');

    // num_docs_indexed stays at its old value through a re-index; the attempt's own count moves.
    const line = `cc_pair ${ccPairId}: ${info.num_docs_indexed}/${expected} documents, ` +
      `attempt ${attempt?.id ?? '-'} ${attempt?.status ?? 'not started'}` +
      (attempt && !terminal ? ` (${attempt.total_docs_indexed} processed)` : '');
    if (line !== lastLine || Date.now() - lastLogAt > HEARTBEAT_MS) {
      log(line);
      lastLine = line;
      lastLogAt = Date.now();
    }

    const settled = attempt !== undefined && attempt.id > afterAttempt && terminal && !info.indexing;
    if (!settled) {
      if (info.indexing || (attempt !== undefined && !terminal)) sawIndexing = true;
      if (attempt === undefined && Date.now() - started > 10 * 60 * 1000) {
        throw new Error(`Onyx has not started indexing cc_pair ${ccPairId} after 10 minutes. Is onyx-background-1 running?`);
      }
      if (Date.now() > deadline) throw new Error(`Timed out after ${INDEXING_TIMEOUT_MS / 60000} minutes: ${line}`);
      await sleep(POLL_MS);
      continue;
    }

    if (info.num_docs_indexed === expected) {
      if (!sawIndexing) return info;
      const since = attempt.time_started ? new Date(attempt.time_started) : new Date(started);
      const failures = chunkContextFailures(since);
      if (failures === 0) return info;
      log(`attempt ${attempt.id}: ${failures} chunk context call(s) failed, so those chunks have no context`);
    } else {
      log(
        `attempt ${attempt.id} finished ${attempt.status} with ${info.num_docs_indexed}/${expected} documents` +
          (attempt.error_msg ? `: ${attempt.error_msg}` : ''),
      );
    }

    if (reindexes >= MAX_REINDEXES) {
      throw new Error(
        `cc_pair ${ccPairId} is still incomplete after ${reindexes} full re-index(es).\n` +
          `  Errors: GET /api/manage/admin/cc-pair/${ccPairId}/errors\n` +
          '  Logs:   docker logs onyx-background-1 2>&1 | grep -i "chunk summary\\|Failed to index"',
      );
    }
    reindexes += 1;
    afterAttempt = attempt.id;
    sawIndexing = true;
    log(`re-indexing from the beginning (${reindexes}/${MAX_REINDEXES})`);
    await onyx.runConnectorOnce(info.connector.id, info.credential.id, true);
    await sleep(POLL_MS);
  }
}

async function pointDocumentSet(onyx: OnyxClient, manifest: Manifest, name: string, ccPairId: number): Promise<void> {
  const description = corpusRef(manifest, name).document_set_description;
  const existing = (await onyx.listDocumentSets()).find((d) => d.name === name);

  if (!existing) {
    await onyx.createDocumentSet({ name, description, cc_pair_ids: [ccPairId] });
    log(`created document set ${name} -> cc_pair ${ccPairId}`);
  } else {
    const current = existing.cc_pair_summaries.map((p) => p.id);
    if (current.length !== 1 || current[0] !== ccPairId) {
      await onyx.updateDocumentSet({ id: existing.id, name, description, cc_pair_ids: [ccPairId] });
      log(`document set ${name}: cc_pairs [${current.join(', ')}] -> [${ccPairId}]`);
    }
  }

  await pollUntil(
    () => onyx.listDocumentSets(),
    (sets) => sets.find((d) => d.name === name)?.is_up_to_date === true,
    { intervalMs: 5000, timeoutMs: 30 * 60 * 1000, label: `document set ${name} to sync` },
  );
  log(`document set ${name} is in sync`);
}

/** Deletes every other connector this script seeded for the doc set. Nothing else is touched. */
async function retireOlderPairs(onyx: OnyxClient, corpus: Corpus, keep: number): Promise<void> {
  const older = (await onyx.getIndexingStatuses()).filter(
    (s) => s.cc_pair_id !== keep && (s.name ?? '').startsWith(corpus.connectorPrefix),
  );
  for (const s of older) {
    const info = await onyx.getCcPair(s.cc_pair_id);
    if (info.status === 'DELETING') continue;
    await onyx.setCcPairStatus(info.id, 'PAUSED');
    await onyx.deleteCcPair(info.connector.id, info.credential.id);
    log(`deleting older connector ${info.name} (cc_pair ${info.id})`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--corpus');
  // --corpus wins; otherwise the run's corpus, which `npm run seed` sets to the rentals set.
  const docSet = at >= 0 ? args[at + 1] : process.env.EVAL_CORPUS || undefined;
  if (at >= 0 && !docSet) throw new Error('--corpus needs a doc_set name.');
  const unknown = args.filter((a, i) => a !== '--reindex' && i !== at && i !== at + 1);
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Options: --reindex, --corpus <doc_set>.`);
  }
  const reindex = args.includes('--reindex');

  const manifest = loadManifest();
  const corpus = loadManifestCorpus(manifest, docSet);
  log(`corpus ${corpus.corpusId}, doc set ${corpus.docSet}: ${corpus.files.length} files -> ${corpus.connectorName}`);

  const problems = checksumProblems(corpus);
  if (problems.length > 0) {
    const where = corpusRef(manifest, corpus.docSet).manifest;
    throw new Error(`Files do not match ${where}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  const onyx = clientFromEnv();
  await checkReachability(onyx);
  await checkIndexingSettings(onyx, manifest);
  await checkEvalModel(onyx, manifest);
  checkBackgroundEnv(manifest);

  const existing = await findSeededPair(onyx, corpus.connectorName);
  const ccPairId = existing ?? (await createSeededPair(onyx, corpus));
  await waitForIndexing(onyx, ccPairId, corpus.files.length, reindex && existing !== undefined);
  await pointDocumentSet(onyx, manifest, corpus.docSet, ccPairId);
  await retireOlderPairs(onyx, corpus, ccPairId);
  log(`done: ${corpus.files.length} documents indexed in cc_pair ${ccPairId}`);
}

main().catch((err) => {
  console.error(`[seed] FAIL: ${err instanceof OnyxError || err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
