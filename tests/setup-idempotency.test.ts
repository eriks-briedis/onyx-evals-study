/**
 * Integration test 1: the setup hook is idempotent.
 *
 * Runs prepareEnvironment() twice against a seeded environment and asserts the second
 * run creates no new connectors, document sets or personas. Every create in the hook is
 * preceded by a lookup on a stable name; this is what proves it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { clientFromEnv, loadManifest, prepareEnvironment } from '../src/setup.js';
import type { OnyxClient } from '../src/onyx.js';

interface Counts {
  connectors: number;
  documentSets: number;
  personas: number;
}

async function snapshot(onyx: OnyxClient): Promise<Counts> {
  const [connectors, documentSets, personas] = await Promise.all([
    onyx.listConnectorStatuses(),
    onyx.listDocumentSets(),
    onyx.listPersonas(),
  ]);
  return {
    connectors: connectors.length,
    documentSets: documentSets.length,
    personas: personas.length,
  };
}

describe('setup hook idempotency', { concurrency: 1 }, () => {
  let onyx: OnyxClient;

  before(() => {
    onyx = clientFromEnv();
  });

  it('creates nothing new on a second run', async () => {
    const manifest = loadManifest();

    // First run may legitimately create the document set and personas.
    const first = await prepareEnvironment(onyx, manifest);
    const afterFirst = await snapshot(onyx);

    const second = await prepareEnvironment(onyx, manifest);
    const afterSecond = await snapshot(onyx);

    assert.deepEqual(
      afterSecond,
      afterFirst,
      'second prepareEnvironment() changed resource counts',
    );
    assert.deepEqual(
      second.personaIds,
      first.personaIds,
      'persona ids changed between runs, so personas were recreated',
    );
    assert.equal(second.documentSetName, first.documentSetName);
    assert.equal(second.searchToolId, first.searchToolId);
  });

  it('leaves the eval user memory-clean', async () => {
    const me = await onyx.getMe();
    assert.equal(me.personalization?.use_memories, false);
    assert.equal(me.personalization?.enable_memory_tool, false);
    assert.ok(!me.personalization?.name, 'personal_name should be empty');
    assert.ok(!me.personalization?.role, 'personal_role should be empty');
  });
});
