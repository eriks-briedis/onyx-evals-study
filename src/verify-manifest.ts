/**
 * Standalone manifest check: `npm run verify`.
 *
 * Runs the same reachability, model and corpus checks as the beforeAll hook, plus the
 * indexing settings `npm run seed` depends on, without creating anything. Useful for
 * confirming an environment before spending a run on it.
 */
import { OnyxError } from './onyx.js';
import {
  checkEvalModel,
  checkIndexingSettings,
  clientFromEnv,
  loadManifest,
  verifyCorpus,
} from './setup.js';

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  if (err instanceof OnyxError) {
    die(
      `FAIL: ${err.message}` +
        (err.status === 401 || err.status === 403
          ? '\n      The API key was rejected or lacks scope. Create an admin-scoped key ' +
            'in the Onyx admin panel.'
          : ''),
    );
  }
  die(`FAIL: ${err.message}`);
});

let onyx;
try {
  onyx = clientFromEnv();
} catch (err) {
  die(`FAIL: ${(err as Error).message}`);
}
const manifest = loadManifest();

if (!(await onyx.health())) {
  console.error('FAIL: /api/health did not return 200');
  process.exit(1);
}

const me = await onyx.getMe();
console.log(`user:        ${me.email}`);
console.log(`permissions: ${(me.effective_permissions ?? []).join(', ') || 'none'}`);

const p = me.personalization;
console.log(
  `memory:      use_memories=${p?.use_memories} enable_memory_tool=${p?.enable_memory_tool} ` +
    `name=${JSON.stringify(p?.name ?? null)} role=${JSON.stringify(p?.role ?? null)}`,
);

let failed = false;
async function check(label: string, fn: () => Promise<string>): Promise<void> {
  try {
    console.log(`${label.padEnd(13)}${await fn()}`);
  } catch (err) {
    console.error(`${label.padEnd(13)}${(err as Error).message}`);
    failed = true;
  }
}

await check('eval model:', async () => {
  await checkEvalModel(onyx, manifest);
  return (
    manifest.models
      .map((m) => {
        const cascade =
          m.llm_override_covers_cascade === null
            ? 'cascade UNVERIFIED'
            : `cascade ${m.llm_override_covers_cascade ? 'covered' : 'NOT covered'} (${m.llm_override_verified_at})`;
        const via = m.provider ? `, via ${m.provider}` : '';
        return `${m.label}=configuration ${m.model_configuration_id} (${m.model_name}${via}, ${cascade})`;
      })
      .join('\n             ') + `\n             others via ${manifest.llm_provider_name}`
  );
});
await check('indexing:', async () => {
  await checkIndexingSettings(onyx, manifest);
  const s = manifest.search_settings;
  if (!s.enable_contextual_rag) {
    return 'contextual RAG off, image analysis ' +
      (manifest.workspace_settings.image_extraction_and_analysis_enabled ? 'on' : 'off');
  }
  return `${s.contextual_rag_model_name} (configuration ${s.contextual_rag_model_configuration_id}), ` +
    `max_input_tokens ${s.contextual_rag_max_input_tokens}, image analysis ` +
    (manifest.workspace_settings.image_extraction_and_analysis_enabled ? 'on' : 'off');
});
await check('corpus:', async () => {
  const { ccPairId, documentSetName } = await verifyCorpus(onyx, manifest);
  return `cc_pair ${ccPairId} fully indexed, document set ${documentSetName} in sync`;
});

const personas = await onyx.listPersonas();
for (const spec of manifest.personas) {
  const found = personas.find((x) => x.name === spec.name);
  console.log(`persona:     ${spec.name} -> ${found ? `id ${found.id}` : 'ABSENT (will be created)'}`);
}

if (failed) process.exit(1);
