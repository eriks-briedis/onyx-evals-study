/**
 * Integration test 2: the composed system prompt carries no user state.
 *
 * The obvious check, that the `# User Information` block is absent, cannot hold:
 * chat/prompt_utils.py:172 gates the block on `name or email or role`, and the API key's
 * user has a synthetic `__danswer_api_key_...@...` email that is never empty. So the
 * block always renders with `## Basic Information`.
 *
 * The achievable invariant is narrower and still covers memories, preferences and
 * identity in one place — which a memory-only check would miss:
 *   - `# User Information` appears exactly once, and holds only Basic Information
 *   - the `User name:` line is empty and there is no `User role:` line
 *   - no `## User Memories`, `## User Preferences`, `## Organization Profile`,
 *     `## Team Information`
 *   - the memory tool is not in the model's toolset
 *
 * The prompt is read from the Langfuse trace, since no Onyx route returns it.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { clientFromEnv, prepareEnvironment } from '../src/setup.js';
import {
  clickHouseConfigFromEnv,
  fetchLlmLoopInput,
  systemPromptFrom,
} from '../src/telemetry.js';
import type { ChatFullResponse } from '../src/types.js';

const SETTLE_MS = 5000;
const ATTEMPTS = 12;

describe('prompt cleanliness', { concurrency: 1 }, () => {
  let prompt: string;
  let toolCallNames: string[];
  let toolDefinitions: Record<string, string>;
  let response: ChatFullResponse;

  before(async () => {
    const onyx = clientFromEnv();
    const ctx = await prepareEnvironment(onyx);
    const personaId = ctx.personaIds.rentals;
    assert.ok(personaId !== undefined, 'no rentals persona resolved');

    response = await onyx.sendMessage({
      message: 'It is 1 October 2025. Can my landlord increase the rent twice in one year?',
      personaId,
      documentSets: [ctx.documentSetName],
      modelConfigurationId: ctx.manifest.models[0]!.model_configuration_id,
      temperature: 0,
    });
    assert.ok(response.chat_session_id, 'no chat_session_id returned');

    // Langfuse ingestion is asynchronous.
    const cfg = clickHouseConfigFromEnv();
    let row = null;
    for (let i = 0; i < ATTEMPTS && !row; i += 1) {
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      row = await fetchLlmLoopInput(cfg, response.chat_session_id!);
    }
    assert.ok(row, `no run_llm_loop trace for session ${response.chat_session_id}`);
    prompt = systemPromptFrom(row.input);
    toolCallNames = row.tool_call_names ?? [];
    toolDefinitions = row.tool_definitions ?? {};
  });

  it('renders the User Information block at most once', () => {
    const occurrences = prompt.split('# User Information').length - 1;
    assert.ok(occurrences <= 1, `# User Information appeared ${occurrences} times`);
  });

  it('renders only the Basic Information sub-section', () => {
    const start = prompt.indexOf('# User Information');
    if (start === -1) return; // nothing to constrain
    const block = prompt.slice(start, prompt.indexOf('\n# ', start + 1) + 1 || undefined);
    const subsections = [...block.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(subsections, ['Basic Information'], `unexpected sub-sections: ${subsections}`);
  });

  it('carries no name and no role', () => {
    // Match within a single line: the value ends at the newline, not at the document end.
    const name = /^User name:[ \t]*(.*)$/m.exec(prompt);
    if (name) assert.equal(name[1]?.trim(), '', `User name leaked: ${name[1]}`);
    assert.ok(!/^User role:/m.test(prompt), 'User role line is present');
  });

  it('carries no memories, preferences, org profile or team information', () => {
    for (const header of [
      '## User Memories',
      '## User Preferences',
      '## Organization Profile',
      '## Team Information',
    ]) {
      assert.ok(!prompt.includes(header), `${header} is present in the system prompt`);
    }
  });

  it('does not expose the memory tool', () => {
    // MemoryTool.NAME is `add_memory`. tool_constructor.py:518 injects it bypassing both
    // persona tool_ids and allowed_tool_ids, so only the user flag can remove it.
    assert.ok(!toolCallNames.includes('add_memory'), 'add_memory was called');
    assert.ok(
      !Object.keys(toolDefinitions).includes('add_memory'),
      'add_memory is in the toolset',
    );
  });

  it('ran the internal search tool', () => {
    const called = response.tool_calls.map((c) => c.tool_name);
    assert.ok(called.includes('internal_search'), `tools called: ${called.join(', ') || 'none'}`);
  });
});
