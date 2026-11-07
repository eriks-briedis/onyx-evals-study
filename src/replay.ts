/**
 * A promptfoo provider that answers with the Onyx response a previous run saved, so the
 * asserts and judges can be re-run without asking Onyx (or a 5-minute local model) again.
 *
 * Used by promptfooconfig.regrade.yaml. `config.results` is a promptfoo -o JSON file; each
 * test is matched to its saved result by case id (metadata.id). The replayed output is the
 * whole ChatFullResponse, exactly as the original asserts saw it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Saved {
  output: unknown;
  latencyMs?: number;
  error?: string;
}

export default class ReplayProvider {
  private readonly saved = new Map<string, Saved>();
  private readonly label: string;

  constructor(options: { id?: string; label?: string; config?: { results?: string } }) {
    const path = options.config?.results;
    if (!path) throw new Error('replay provider needs config.results (a promptfoo -o JSON file)');
    const doc = JSON.parse(readFileSync(resolve(path), 'utf8'));
    const labels = new Set<string>();
    for (const r of doc.results.results) {
      const id = r.testCase?.metadata?.id;
      if (typeof id !== 'string') continue;
      if (this.saved.has(id)) throw new Error(`${path} holds case ${id} twice; replay needs one answer per case`);
      labels.add(r.provider?.label);
      this.saved.set(id, { output: r.response?.output, latencyMs: r.latencyMs, error: r.response?.error });
    }
    if (labels.size !== 1) throw new Error(`${path} mixes providers (${[...labels].join(', ')}); replay one at a time`);
    this.label = options.label ?? String([...labels][0]);
  }

  id(): string {
    return this.label;
  }

  async callApi(_prompt: string, context?: { test?: { metadata?: { id?: string } } }) {
    const id = context?.test?.metadata?.id;
    const hit = id ? this.saved.get(id) : undefined;
    if (!hit) return { error: `no saved answer for case ${id}` };
    return { output: hit.output, latencyMs: hit.latencyMs, ...(hit.error ? { error: hit.error } : {}) };
  }
}
