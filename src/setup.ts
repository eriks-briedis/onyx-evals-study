/**
 * promptfoo `extensions` hook.
 *
 * Registered as `file://dist/src/setup.js:hook`. Verifies the environment against the
 * manifest, makes the calling user memory-clean, checks the corpus `npm run seed` indexed,
 * ensures the personas exist, and binds the resolved persona ids into the provider bodies. On `afterAll` it
 * joins the run to Langfuse telemetry and optionally deletes the sessions it created.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Agent, setGlobalDispatcher } from 'undici';

import { type Corpus, loadCorpus } from './corpus.js';
import { OnyxClient, OnyxError } from './onyx.js';
import {
  clickHouseConfigFromEnv,
  cascadeCoverage,
  waitForSessions,
} from './telemetry.js';
import type { CorpusRef, LlmProvider, Manifest, RunContext } from './types.js';

// Node's fetch gives up after 300 s without response headers, whatever timeout the caller
// sets. A local model behind Onyx (qwen3.6 on Ollama) takes longer than that for one chat
// turn, and promptfoo's requests go through the same global dispatcher, so lift it here.
setGlobalDispatcher(new Agent({ headersTimeout: 30 * 60_000, bodyTimeout: 30 * 60_000 }));

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const MANIFEST_PATH = resolve(REPO_ROOT, 'manifest', 'manifest.json');
export const RUN_CONTEXT_PATH = resolve(REPO_ROOT, '.promptfoo-run.json');

export function loadManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

export function readRunContext(path = RUN_CONTEXT_PATH): RunContext {
  return JSON.parse(readFileSync(path, 'utf8')) as RunContext;
}

/**
 * Prefers an API key, falls back to the eval user's password.
 *
 * On a Community deployment the key path is unavailable: `POST /admin/api-key` is behind
 * the Business tier gate. Password login is not gated, so that is the default here.
 */
export function clientFromEnv(env = process.env): OnyxClient {
  const baseUrl = env.ONYX_BASE_URL;
  if (!baseUrl) throw new Error('ONYX_BASE_URL must be set. See .env.example.');

  if (env.ONYX_API_KEY) {
    return new OnyxClient(baseUrl, { kind: 'apiKey', apiKey: env.ONYX_API_KEY });
  }
  const email = env.ONYX_EVAL_USER_EMAIL;
  const password = env.ONYX_EVAL_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Set either ONYX_API_KEY, or ONYX_EVAL_USER_EMAIL + ONYX_EVAL_USER_PASSWORD.\n' +
        'Service-account API keys need the Business tier; password login does not.\n' +
        'Bootstrap the eval user with: npm run bootstrap',
    );
  }
  return new OnyxClient(baseUrl, { kind: 'password', email, password });
}

const ADMIN_PERMISSIONS = ['admin', 'FULL_ADMIN_PANEL_ACCESS', 'add:agents'];

/**
 * Step 1. Reachability and scope.
 *
 * ADD_AGENTS, MANAGE_DOCUMENT_SETS and MANAGE_CONNECTORS are not in Permission.IMPLIED
 * (db/enums.py:686-702), so a basic key reaches /chat but fails every setup call. Say so
 * here rather than at the first confusing 403.
 */
export async function checkReachability(onyx: OnyxClient): Promise<string> {
  if (!(await onyx.health())) {
    throw new Error('Onyx /api/health did not return 200. Is ONYX_BASE_URL correct?');
  }

  let me;
  try {
    me = await onyx.getMe();
  } catch (err) {
    if (err instanceof OnyxError && (err.status === 401 || err.status === 403)) {
      throw new Error(
        'ONYX_API_KEY was rejected (HTTP ' + err.status + '). Create an admin-scoped key ' +
          'in the Onyx admin panel and put it in .env as ONYX_API_KEY=on_...',
      );
    }
    throw err;
  }

  const perms = me.effective_permissions ?? [];
  const isAdmin = perms.some((p) => ADMIN_PERMISSIONS.includes(p));
  if (!isAdmin) {
    throw new Error(
      `The API key resolves to ${me.email} but carries no admin permission ` +
        `(effective_permissions: ${perms.join(', ') || 'none'}).\n` +
        'Create an admin-scoped key in the Onyx admin panel: persona and document-set ' +
        'creation need ADD_AGENTS and MANAGE_DOCUMENT_SETS, which are not implied.',
    );
  }
  return me.email;
}

/**
 * Step 2. Make the calling user memory-clean. This must run before anything else.
 *
 * The API key's own SERVICE_ACCOUNT user row (db/api_key.py:148) sets neither memory
 * flag, so both land on the column default `true` (db/models.py:402-405). With
 * enable_memory_tool true, tool_constructor.py:518 injects MemoryTool into every call
 * "bypassing persona tool associations and allowed_tool_ids filtering" — excluding it
 * from the persona's tool_ids does nothing at all. With use_memories true, memories,
 * preferences and identity are composed into the system prompt.
 */
export async function ensureCleanUser(onyx: OnyxClient): Promise<void> {
  // This wipes name, role, memories and preferences. That is fine for a dedicated eval
  // account and destructive for a human's. Refuse unless the caller opted in.
  const before = await onyx.getMe();
  const expected = process.env.ONYX_EVAL_USER_EMAIL;
  const isServiceAccount = before.email.startsWith('__danswer_api_key_');
  const isDeclaredEvalUser = expected !== undefined && before.email === expected;
  if (!isServiceAccount && !isDeclaredEvalUser && process.env.ONYX_ALLOW_DIRTY_USER !== '1') {
    throw new Error(
      `Refusing to wipe personalization for ${before.email}: it is neither a service ` +
        'account nor the declared ONYX_EVAL_USER_EMAIL.\n' +
        'This step clears name, role, memories and preferences, which would destroy real ' +
        'user data. Run `npm run bootstrap` to create a dedicated eval user, or set ' +
        'ONYX_ALLOW_DIRTY_USER=1 if you genuinely mean to clean this account.',
    );
  }

  await onyx.patchPersonalization({
    name: '',
    role: '',
    use_memories: false,
    enable_memory_tool: false,
    memories: [],
    user_preferences: '',
  });

  const me = await onyx.getMe();
  const p = me.personalization;
  const problems: string[] = [];
  if (!p) problems.push('GET /me returned no personalization block');
  else {
    if (p.use_memories !== false) problems.push('use_memories is still true');
    if (p.enable_memory_tool !== false) problems.push('enable_memory_tool is still true');
    if (p.name) problems.push(`personal_name is still ${JSON.stringify(p.name)}`);
    if (p.role) problems.push(`personal_role is still ${JSON.stringify(p.role)}`);
  }
  if (problems.length > 0) {
    throw new Error(`Eval user is not memory-clean: ${problems.join('; ')}`);
  }
}

/**
 * The doc set a run queries: EVAL_CORPUS when set (one of the manifest's corpora), otherwise
 * manifest.corpus. promptfooconfig.rentals.yaml is run with EVAL_CORPUS=vic-rentals-baseline.
 */
export function runDocSet(manifest: Manifest, env = process.env): string {
  return corpusRef(manifest, env.EVAL_CORPUS || undefined).doc_set;
}

/** The run's corpus, or with `docSet` one of `manifest.extra_corpora`. */
export function corpusRef(manifest: Manifest, docSet = manifest.corpus.doc_set): CorpusRef {
  const refs = [manifest.corpus, ...(manifest.extra_corpora ?? [])];
  const ref = refs.find((r) => r.doc_set === docSet);
  if (!ref) throw new Error(`manifest.json has no corpus for doc_set ${docSet}; known: ${refs.map((r) => r.doc_set).join(', ')}`);
  return ref;
}

export function loadManifestCorpus(manifest: Manifest, docSet?: string): Corpus {
  const ref = corpusRef(manifest, docSet);
  return loadCorpus(resolve(REPO_ROOT, ref.manifest), ref.doc_set);
}

function findModelConfiguration(providers: LlmProvider[], id: number) {
  for (const provider of providers) {
    const model = provider.model_configurations.find((m) => m.id === id);
    if (model) return { provider, model };
  }
  return undefined;
}

/**
 * Every model must be reached through the provider the manifest names for it (by default
 * manifest.llm_provider_name, the gateway). The same model name can exist under several Onyx
 * providers — `claude-haiku-5-5` under the gateway and under a direct `anthropic` provider —
 * so this checks which provider owns the configuration id the eval sends.
 */
export async function checkEvalModel(onyx: OnyxClient, manifest: Manifest): Promise<void> {
  const providers = await onyx.listLlmProviders();
  const problems: string[] = [];

  for (const want of manifest.models) {
    const found = findModelConfiguration(providers, want.model_configuration_id);
    if (!found) {
      problems.push(`${want.label}: configuration ${want.model_configuration_id} does not exist in Onyx`);
      continue;
    }
    // A model names its provider only to bypass the gateway on purpose (a direct API or local model).
    const wantProvider = want.provider ?? manifest.llm_provider_name;
    const owner = found.provider.name ?? found.provider.provider;
    if (owner !== wantProvider) {
      problems.push(
        `${want.label}: configuration ${want.model_configuration_id} belongs to provider ` +
          `${found.provider.id} (${owner}), not ${wantProvider}`,
      );
    }
    if (found.model.name !== want.model_name) {
      problems.push(
        `${want.label}: configuration ${want.model_configuration_id} is ${found.model.name}, ` +
          `not ${want.model_name}`,
      );
    }
  }

  const labels = manifest.models.map((m) => m.label);
  if (new Set(labels).size !== labels.length) {
    problems.push(`duplicate model label(s) in manifest.models: ${labels.join(', ')}`);
  }

  if (problems.length > 0) {
    throw new Error(
      `Model axis does not match Onyx:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        `Every eval call must go through ${manifest.llm_provider_name} unless a model names its ` +
        'provider. The same model names ' +
        'exist on the direct `anthropic` and `openai` providers, so route by ' +
        'model_configuration_id and never by name.',
    );
  }
}

/**
 * The indexing side of the environment pin: the contextual RAG model, the input limit
 * Onyx trims documents to before sending them, and image analysis.
 *
 * The input limit is set by hand to match Ollama's context length, and re-saving the
 * Ollama provider in the admin UI resets it. Image analysis is on by default; with no
 * vision model designated, Onyx picks the first capable one it finds — here a 27B model
 * that does not fit beside the indexing model — and embedded PDF images stall indexing.
 */
export async function checkIndexingSettings(onyx: OnyxClient, manifest: Manifest): Promise<void> {
  const want = manifest.search_settings;
  const [settings, providers, workspace] = await Promise.all([
    onyx.getSearchSettings(),
    onyx.listLlmProviders(),
    onyx.getWorkspaceSettings(),
  ]);
  const problems: string[] = [];

  const imagesWanted = manifest.workspace_settings.image_extraction_and_analysis_enabled;
  // Onyx treats an unset value as enabled (server/settings/models.py).
  if ((workspace.image_extraction_and_analysis_enabled ?? true) !== imagesWanted) {
    problems.push(
      `image_extraction_and_analysis_enabled is ${workspace.image_extraction_and_analysis_enabled}, ` +
        `manifest pins ${imagesWanted}. Restore it with PATCH /api/admin/settings ` +
        `{"image_extraction_and_analysis_enabled": ${imagesWanted}}`,
    );
  }

  if (settings.model_name !== want.model_name) {
    problems.push(`embedding model is ${settings.model_name}, manifest pins ${want.model_name}`);
  }
  if (settings.enable_contextual_rag !== want.enable_contextual_rag) {
    problems.push(`enable_contextual_rag is ${settings.enable_contextual_rag}`);
  }
  // With contextual RAG off no indexing LLM is called, so its model is not part of the pin.
  if (want.enable_contextual_rag && settings.contextual_rag_model_configuration_id !== want.contextual_rag_model_configuration_id) {
    problems.push(
      `contextual RAG model is configuration ${settings.contextual_rag_model_configuration_id}, ` +
        `manifest pins ${want.contextual_rag_model_configuration_id}`,
    );
  }
  const found = want.enable_contextual_rag
    ? findModelConfiguration(providers, want.contextual_rag_model_configuration_id as number)
    : undefined;
  if (!want.enable_contextual_rag) {
    // nothing further to check
  } else if (!found) {
    problems.push(`model configuration ${want.contextual_rag_model_configuration_id} does not exist`);
  } else {
    if (found.model.name !== want.contextual_rag_model_name) {
      problems.push(`configuration ${found.model.id} is ${found.model.name}, not ${want.contextual_rag_model_name}`);
    }
    if (found.model.max_input_tokens !== want.contextual_rag_max_input_tokens) {
      problems.push(
        `${found.model.name} max_input_tokens is ${found.model.max_input_tokens}, manifest pins ` +
          `${want.contextual_rag_max_input_tokens}. Restore it with:\n` +
          '      docker exec onyx-relational_db-1 psql -U postgres -d postgres -c \\\n' +
          `        "update model_configuration set max_input_tokens = ${want.contextual_rag_max_input_tokens} ` +
          `where id = ${found.model.id};"`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Indexing settings drift against manifest/manifest.json:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

/**
 * Step 3. Verify the seeded corpus: the connector named for the current corpus exists with
 * every document indexed, and the document set points at it and nothing else. Seeding is
 * `npm run seed`; this only checks, so a run never starts indexing work.
 *
 * `docs_indexed` reflects the search index, not the Postgres link table — a document row
 * can exist while its chunks never reached the index.
 */
export async function verifyCorpus(
  onyx: OnyxClient,
  manifest: Manifest,
  docSet = runDocSet(manifest),
): Promise<{ ccPairId: number; documentSetName: string }> {
  const corpus = loadManifestCorpus(manifest, docSet);
  const expected = corpus.files.length;
  const hint = `\nRun \`npm run seed -- --corpus ${corpus.docSet}\`.`;

  const status = (await onyx.getIndexingStatuses())
    .filter((s) => s.name === corpus.connectorName)
    .sort((a, b) => a.cc_pair_id - b.cc_pair_id)[0];
  if (!status) {
    throw new Error(`No connector named ${corpus.connectorName} for the current ${corpus.docSet} corpus.${hint}`);
  }
  if (status.docs_indexed !== expected) {
    throw new Error(
      `${corpus.connectorName} (cc_pair ${status.cc_pair_id}) has ${status.docs_indexed} of ` +
        `${expected} documents indexed.${hint}`,
    );
  }

  const set = (await onyx.listDocumentSets()).find((d) => d.name === corpus.docSet);
  const setPairs = (set?.cc_pair_summaries ?? []).map((p) => p.id);
  if (!set || setPairs.length !== 1 || setPairs[0] !== status.cc_pair_id) {
    throw new Error(
      `Document set ${corpus.docSet} ` +
        (set ? `holds cc_pairs [${setPairs.join(', ')}]` : 'does not exist') +
        `, expected exactly [${status.cc_pair_id}].${hint}`,
    );
  }
  if (!set.is_up_to_date) {
    throw new Error(`Document set ${corpus.docSet} has not finished syncing to the index.${hint}`);
  }
  return { ccPairId: status.cc_pair_id, documentSetName: corpus.docSet };
}

/**
 * Step 5. Resolve the search tool id.
 *
 * MemoryTool is deliberately not looked up here: tool_visibility.py:38 sets
 * expose_to_frontend=False, so GET /tool never returns it. It is disabled via the user
 * flag in ensureCleanUser, not via tool_ids.
 */
export async function resolveSearchToolId(onyx: OnyxClient): Promise<number> {
  const tools = await onyx.listTools();
  const search = tools.find((t) => t.in_code_tool_id === 'SearchTool');
  if (!search) {
    throw new Error(
      `No tool with in_code_tool_id "SearchTool" in GET /tool. Saw: ` +
        tools.map((t) => t.in_code_tool_id ?? t.name).join(', '),
    );
  }
  return search.id;
}

/**
 * Step 6. One persona per prompt variant, looked up by stable name and created only if
 * absent. That lookup-before-create is what makes the idempotency test pass.
 *
 * document_set_ids stays empty: scoping is per-request through
 * internal_search_filters.document_set, which takes names and so survives environments.
 */
export async function ensurePersonas(
  onyx: OnyxClient,
  manifest: Manifest,
  searchToolId: number,
): Promise<Record<string, number>> {
  const existing = await onyx.listPersonas();
  const byName = new Map(existing.map((p) => [p.name, p]));
  const ids: Record<string, number> = {};

  for (const spec of manifest.personas) {
    const found = byName.get(spec.name);
    if (found) {
      ids[spec.variant] = found.id;
      continue;
    }
    const created = await onyx.createPersona({
      name: spec.name,
      description: spec.description,
      system_prompt: spec.system_prompt,
      task_prompt: spec.task_prompt,
      datetime_aware: spec.datetime_aware,
      replace_base_system_prompt: spec.replace_base_system_prompt,
      tool_ids: spec.search_tool === false ? [] : [searchToolId],
      document_set_ids: [],
    });
    // Persona names carry no unique constraint, so a lost race duplicates rather than
    // erroring. Re-read and keep the lowest id, so every racing caller agrees on one.
    const settled = (await onyx.listPersonas())
      .filter((x) => x.name === spec.name)
      .map((x) => x.id)
      .sort((a, b) => a - b);
    ids[spec.variant] = settled[0] ?? created.id;
  }
  return ids;
}

/**
 * The run condition for Onyx's inferred search filters. EVAL_AUTO_FILTERS=on|off declares it
 * and the run refuses to start if the workspace disagrees; unset, the run records whatever
 * is set. The filter is a workspace toggle, not a request field, so it cannot be set per cell.
 */
export async function checkAutoFilters(onyx: OnyxClient, env = process.env): Promise<boolean> {
  // Onyx treats an unset value as on (chat/process_message.py).
  const actual = (await onyx.getWorkspaceSettings()).auto_detect_search_filters !== false;
  const declared = env.EVAL_AUTO_FILTERS;
  if (declared === undefined || declared === '') return actual;
  if (declared !== 'on' && declared !== 'off') {
    throw new Error(`EVAL_AUTO_FILTERS is ${declared}; use on or off.`);
  }
  if ((declared === 'on') !== actual) {
    throw new Error(
      `EVAL_AUTO_FILTERS=${declared}, but auto_detect_search_filters is ${actual ? 'on' : 'off'} ` +
        `in Onyx. Switch it with npm run filters -- ${declared}`,
    );
  }
  return actual;
}

/** The document_set a perfect-filter provider sends; promptfoo fills it from the test's vars. */
export const AS_OF_TEMPLATE = '{{as_of_doc_set}}';

/**
 * The per-date document sets a perfect-filter run's tests search, each checked like the run's
 * own corpus. Empty for every other run.
 */
export async function verifyAsOfCorpora(onyx: OnyxClient, manifest: Manifest, tests: any[]): Promise<string[]> {
  const sets = [...new Set(tests.map((t) => t?.vars?.as_of_doc_set).filter((s): s is string => typeof s === 'string'))];
  if (sets.length > 0 && tests.some((t) => typeof t?.vars?.as_of_doc_set !== 'string')) {
    throw new Error('Some tests set vars.as_of_doc_set and some do not; a perfect-filter run needs it on every test.');
  }
  for (const set of sets.sort()) await verifyCorpus(onyx, manifest, set);
  return sets;
}

/**
 * The in-container api_server patches the manifest pins (onyx_api_server_patches). Each
 * patch's apply script answers `check`; a recreated container has lost the patch and would
 * run stock Onyx under the patched label. Skipped with ONYX_SKIP_DOCKER_CHECKS=1.
 */
export function checkApiServerPatches(manifest: Manifest, env = process.env): void {
  const patches = manifest.onyx_api_server_patches ?? [];
  if (patches.length === 0) return;
  if (env.ONYX_SKIP_DOCKER_CHECKS === '1') {
    console.log('[onyx-evals] warning: ONYX_SKIP_DOCKER_CHECKS=1, not checking the api_server patches');
    return;
  }
  const problems: string[] = [];
  for (const p of patches) {
    const res = spawnSync('bash', [resolve(REPO_ROOT, p.apply), 'check'], { encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      problems.push(`  - ${p.name}: ${(res.error?.message ?? `${res.stdout}${res.stderr}`).trim()}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Onyx api_server patch drift against manifest/manifest.json:\n${problems.join('\n')}\n` +
        'Apply the patch with `<apply> apply`, or drop it from onyx_api_server_patches to measure stock Onyx.',
    );
  }
}

/**
 * The api_server environment the manifest pins (onyx_api_server_env), read through docker
 * the way the seed reads the background worker's. A container recreated from a stale .env
 * would run with other timeouts under the same label. Skipped with ONYX_SKIP_DOCKER_CHECKS=1.
 */
export function checkApiServerEnv(manifest: Manifest, env = process.env): void {
  const want = manifest.onyx_api_server_env ?? {};
  const names = Object.keys(want).filter((name) => !name.startsWith('$'));
  if (names.length === 0) return;
  if (env.ONYX_SKIP_DOCKER_CHECKS === '1') {
    console.log('[onyx-evals] warning: ONYX_SKIP_DOCKER_CHECKS=1, not checking the api_server environment');
    return;
  }
  const container = env.ONYX_API_SERVER_CONTAINER ?? 'onyx-api_server-1';
  // `env`, not `printenv NAME...`: printenv exits non-zero when a name is unset.
  const res = spawnSync('docker', ['exec', container, 'env'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    throw new Error(
      `Cannot read the environment of ${container}: ${(res.error?.message ?? res.stderr).trim()}\n` +
        'Set ONYX_API_SERVER_CONTAINER to the Onyx api_server container, or ONYX_SKIP_DOCKER_CHECKS=1 to skip the checks that need docker.',
    );
  }
  const have = new Map(
    res.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );
  const problems = names
    .filter((name) => have.get(name) !== want[name])
    .map((name) => `  - ${name} is ${have.has(name) ? JSON.stringify(have.get(name)) : 'unset'}, manifest pins ${JSON.stringify(want[name])}`);
  if (problems.length > 0) {
    throw new Error(
      `Onyx api_server environment drift against manifest/manifest.json:\n${problems.join('\n')}\n` +
        'Set these in deployment/docker_compose/.env and recreate only that service, then re-apply any api_server patch:\n' +
        '  docker compose up -d --force-recreate --no-deps api_server',
    );
  }
}

/** Runs steps 1-6 and returns the run context. Exported so the tests can call it twice. */
export async function prepareEnvironment(
  onyx: OnyxClient = clientFromEnv(),
  manifest: Manifest = loadManifest(),
): Promise<RunContext> {
  await checkReachability(onyx);
  await ensureCleanUser(onyx);
  await checkEvalModel(onyx, manifest);
  const { documentSetName } = await verifyCorpus(onyx, manifest);
  const autoDetectSearchFilters = await checkAutoFilters(onyx);
  checkApiServerPatches(manifest);
  checkApiServerEnv(manifest);
  const searchToolId = await resolveSearchToolId(onyx);
  const personaIds = await ensurePersonas(onyx, manifest, searchToolId);

  return {
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    baseUrl: process.env.ONYX_BASE_URL ?? '',
    documentSetName,
    searchToolId,
    personaIds,
    autoDetectSearchFilters,
    manifest,
  };
}

/**
 * Step 7. Bind resolved ids into the provider bodies.
 *
 * Provider labels carry the variant name, so `label: baseline` picks up
 * personaIds.baseline. beforeAll persists a returned context and the mutation reaches the
 * wire (verified against promptfoo's HttpProvider).
 *
 * An unbound provider is a hard error, not a warning. The YAML placeholder is
 * `persona_id: 0`, which is a real persona — the default Assistant — so a silent miss
 * would run the whole suite against the wrong assistant and report nothing.
 */
export function bindProviders(suite: any, ctx: RunContext, onyx: OnyxClient): number {
  const authHeaders = onyx.authHeaders();
  if (Object.keys(authHeaders).length === 0) {
    throw new Error(
      'No auth headers available to give the providers. The client must be logged in ' +
        'before bindProviders runs, or every eval request will be sent unauthenticated ' +
        'and Onyx will answer 403.',
    );
  }
  let bound = 0;
  const unmatched: string[] = [];
  // A YAML anchor (`<<: *onyx`) makes two providers share ONE body object, so binding the
  // second silently rewrites the first and both cells run the same model under different
  // labels — the exact mislabelling this suite exists to detect. Cheap to check, fatal to miss.
  const seenBodies = new Set<unknown>();

  for (const provider of suite?.providers ?? []) {
    const body = provider?.config?.body;
    // Only HTTP providers targeting Onyx carry a chat body; skip anything else
    // (a judge provider, for instance).
    if (!body?.chat_session_info) continue;
    if (seenBodies.has(body)) {
      throw new Error(
        `Two providers share one config.body object (at label ${String(provider?.label)}). ` +
          'That is almost always a YAML anchor or merge key in promptfooconfig.yaml. Binding ' +
          'the second would overwrite the first, and both cells would run the same persona ' +
          'and model under different labels. Write each provider out in full.',
      );
    }
    seenBodies.add(body);

    // `label` is a plain string; `id` is a function returning the URL, so it is no use
    // as a cell name. The label carries both axes: `<promptVariant>:<modelLabel>`.
    const label = typeof provider?.label === 'string' ? provider.label : undefined;
    const [variant, modelLabel] = (label ?? '').split(':');
    const personaId = variant ? ctx.personaIds[variant] : undefined;
    const model = modelLabel
      ? ctx.manifest.models.find((m) => m.label === modelLabel)
      : undefined;
    if (personaId === undefined || model === undefined) {
      unmatched.push(label ?? '<no label>');
      continue;
    }

    // Written, not validated. With more than one model on the axis the configuration id
    // belongs to the manifest, and a provider body repeating it by hand is one more place
    // for the two to disagree. checkEvalModel has already vetted every id in the list.
    body.llm_override = { ...(body.llm_override ?? {}), model_configuration_id: model.model_configuration_id };
    body.chat_session_info = { ...body.chat_session_info, persona_id: personaId };
    const perCase = body.internal_search_filters?.document_set;
    if (Array.isArray(perCase) && perCase.length === 1 && perCase[0] === AS_OF_TEMPLATE) {
      // The perfect-filter arm: each test names its own per-date set, verified in beforeAll.
      if (!ctx.asOfDocSets?.length) {
        throw new Error(
          `Provider ${label} searches ${AS_OF_TEMPLATE}, but no test sets vars.as_of_doc_set. ` +
            'Load the tests through dist/src/asofTests.js.',
        );
      }
    } else if (ctx.asOfDocSets?.length) {
      // Without the template this provider would search the full corpus under the arm's name.
      throw new Error(`Provider ${label} must search ${AS_OF_TEMPLATE} in a perfect-filter run.`);
    } else if (body.internal_search_filters) {
      // The config names its set too. A mismatch means the config was run against the wrong
      // corpus (EVAL_CORPUS unset or different), and every answer would come from it.
      const named = body.internal_search_filters.document_set;
      if (Array.isArray(named) && named.length > 0 && (named.length !== 1 || named[0] !== ctx.documentSetName)) {
        throw new Error(
          `Provider ${label} searches document set [${named.join(', ')}], but this run is bound to ` +
            `${ctx.documentSetName}. Set EVAL_CORPUS to match the config (npm run eval:rentals does).`,
        );
      }
      body.internal_search_filters.document_set = [ctx.documentSetName];
    }
    // promptfoo makes these requests itself, so it needs the credentials too.
    provider.config.headers = { ...(provider.config.headers ?? {}), ...authHeaders };
    bound += 1;
  }

  if (unmatched.length > 0) {
    throw new Error(
      `Unresolvable provider label(s): ${unmatched.join(', ')}.\n` +
        `Labels must read <promptVariant>:<modelLabel>. Known variants: ` +
        `${Object.keys(ctx.personaIds).join(', ')}. Known models: ` +
        `${ctx.manifest.models.map((m) => m.label).join(', ')}.\n` +
        'Without both halves a provider would silently run persona 0 (the default ' +
        'Assistant) on whichever model Onyx defaults to.',
    );
  }
  if (bound === 0) {
    throw new Error(
      'bindProviders matched no providers. Every Onyx provider in promptfooconfig.yaml ' +
        'must set config.body.chat_session_info and a `label`.',
    );
  }
  return bound;
}

/** Model family by name: the two API vendors, and anything else (a local model) on its own. */
function modelFamily(name: string): string {
  if (name.startsWith('claude-')) return 'anthropic';
  if (name.startsWith('gpt-')) return 'openai';
  return name;
}

/**
 * Judges cleared to grade their own family's answers, with the evidence. Re-run the
 * hand-check (scripts/hand-check.py) on that family's answers after a gold or rubric change.
 */
const SAME_FAMILY_CLEARED: Record<string, string> = {
  'claude-opus-5-5':
    'hand-check 2026-11-01: agreed with the human on all 39 checks of 13 haiku answers, failures included (results/hand-check)',
};

/**
 * The judge must come from a different family than every model the run answers with, or
 * the grade carries the judge's preference for its own family's answers, unless it is in
 * SAME_FAMILY_CLEARED. Otherwise a run mixing both API families cannot be judged at all;
 * split it by provider (--filter-providers) and set JUDGE_MODEL per part.
 */
export function checkJudge(suite: any, ctx: RunContext): string {
  const id = suite?.defaultTest?.options?.provider?.id;
  const judge = typeof id === 'string' ? id.replace(/^openai:chat:/, '') : '';
  if (!judge || judge.includes('{{')) {
    throw new Error('No judge model: set JUDGE_MODEL (defaultTest.options.provider.id reads it).');
  }
  if (SAME_FAMILY_CLEARED[judge]) {
    console.log(`[onyx-evals] judge ${judge} cleared for its own family: ${SAME_FAMILY_CLEARED[judge]}`);
    return judge;
  }
  const labels = new Set((suite?.providers ?? []).map((p: any) => String(p?.label ?? '').split(':')[1]));
  const clashes = ctx.manifest.models
    .filter((m) => labels.has(m.label) && modelFamily(m.model_name) === modelFamily(judge))
    .map((m) => `${m.label} (${m.model_name})`);
  if (clashes.length > 0) {
    throw new Error(
      `Judge ${judge} is from the same family as ${clashes.join(', ')}. Set JUDGE_MODEL to a ` +
        'model from another family, or run those providers separately with --filter-providers.',
    );
  }
  return judge;
}

function collectSessionIds(results: any[]): string[] {
  const ids = new Set<string>();
  for (const r of results ?? []) {
    const id = r?.response?.output?.chat_session_id;
    if (typeof id === 'string') ids.add(id);
  }
  return [...ids];
}

/**
 * afterAll: join to Langfuse, then optionally clean up.
 *
 * Cleanup runs last and only when ONYX_EVALS_CLEANUP=1, so traces stay inspectable by
 * default. Incognito is deliberately not used: it is off by default
 * (server/security/store.py:103), USAGE_ONLY still writes a session row, and
 * suppresses_external_traces() would drop the whole trace and with it this join.
 */
export async function finishRun(results: any[], ctx: RunContext): Promise<void> {
  const sessionIds = collectSessionIds(results);
  if (sessionIds.length === 0) {
    console.warn('[onyx-evals] No chat_session_id in any result; skipping telemetry join.');
    return;
  }

  try {
    const cfg = clickHouseConfigFromEnv();
    const { telemetry, missing } = await waitForSessions(cfg, sessionIds, {
      excludeModels: [ctx.manifest.search_settings.model_name],
    });
    const expectedModels = ctx.manifest.models.map((m) => m.model_name);
    const coverage = cascadeCoverage(telemetry, expectedModels);

    mkdirSync(resolve(REPO_ROOT, 'results'), { recursive: true });
    const out = resolve(REPO_ROOT, 'results', `telemetry-${ctx.runId}.json`);
    writeFileSync(
      out,
      JSON.stringify(
        {
          runId: ctx.runId,
          startedAt: ctx.startedAt,
          autoDetectSearchFilters: ctx.autoDetectSearchFilters,
          judgeModel: ctx.judgeModel,
          expectedModels,
          llm_override_covers_cascade: coverage.covered,
          sessionsPerModel: coverage.perModel,
          cascadeOffenders: coverage.offenders,
          missingSessions: missing,
          sessions: telemetry,
        },
        null,
        2,
      ),
    );

    const totals = telemetry.reduce(
      (a, t) => ({
        prompt: a.prompt + Number(t.prompt_tokens),
        completion: a.completion + Number(t.completion_tokens),
      }),
      { prompt: 0, completion: 0 },
    );
    console.log(
      `[onyx-evals] Telemetry: ${telemetry.length}/${sessionIds.length} sessions, ` +
        `${totals.prompt} prompt + ${totals.completion} completion tokens -> ${out}`,
    );
    const perModel = Object.entries(coverage.perModel)
      .map(([m, n]) => `${m}=${n}`)
      .join(' ');
    console.log(`[onyx-evals] Sessions per model: ${perModel || 'none'}`);
    if (!coverage.covered) {
      console.warn(
        `[onyx-evals] llm_override did NOT cover the cascade for ` +
          `${coverage.offenders.length} session(s). Expected each session to use exactly one ` +
          `of ${expectedModels.join(', ')}. Offenders: ${coverage.offenders.join('; ')}. ` +
          'The model axis is mislabelled for those sessions.',
      );
    }
    // Per-model coverage is pinned in the manifest one model at a time; a model still
    // marked null there has not been verified, whatever this run saw.
    for (const m of ctx.manifest.models) {
      if (m.llm_override_covers_cascade === null) {
        console.warn(
          `[onyx-evals] ${m.label} (${m.model_name}) has llm_override_covers_cascade: null ` +
            'in the manifest — cascade coverage is UNVERIFIED for it. Read a trace and pin it ' +
            'before reporting anything on that arm.',
        );
      }
    }
  } catch (err) {
    console.warn(`[onyx-evals] Telemetry join skipped: ${(err as Error).message}`);
  }

  if (process.env.ONYX_EVALS_CLEANUP === '1') {
    const onyx = clientFromEnv();
    let deleted = 0;
    for (const id of sessionIds) {
      try {
        await onyx.deleteChatSession(id);
        deleted += 1;
      } catch {
        /* a session that is already gone is not a failure */
      }
    }
    console.log(`[onyx-evals] Deleted ${deleted}/${sessionIds.length} chat sessions.`);
  }
}

/** promptfoo entry point. */
export async function hook(hookName: string, context: any): Promise<any> {
  if (hookName === 'beforeAll') {
    const onyx = clientFromEnv();
    const ctx = await prepareEnvironment(onyx);
    ctx.asOfDocSets = await verifyAsOfCorpora(onyx, ctx.manifest, context.suite?.tests ?? []);
    const bound = bindProviders(context.suite, ctx, onyx);
    ctx.judgeModel = checkJudge(context.suite, ctx);
    writeFileSync(RUN_CONTEXT_PATH, JSON.stringify(ctx, null, 2));
    console.log(
      `[onyx-evals] Ready. providers=${bound} personas=${JSON.stringify(ctx.personaIds)} ` +
        `documentSet=${ctx.asOfDocSets?.length ? `per case (${ctx.asOfDocSets.join(', ')})` : ctx.documentSetName} ` +
        `searchToolId=${ctx.searchToolId} ` +
        `autoFilters=${ctx.autoDetectSearchFilters ? 'on' : 'off'} judge=${ctx.judgeModel}`,
    );
    return context;
  }

  if (hookName === 'afterAll') {
    await finishRun(context.results ?? [], readRunContext());
    return context;
  }

  return context;
}

export default hook;
