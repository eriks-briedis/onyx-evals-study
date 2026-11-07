/**
 * The tests promptfooconfig.regrade.yaml re-judges: datasets/vic-rentals.yaml, with the judge
 * asserts cut down to the ones named in REGRADE_JUDGES (comma-separated metrics, such as
 * `version-cited`). After a rubric change only that judge needs re-running, and the others
 * would only repeat verdicts the original run already holds; scripts/compare-filter-runs.py
 * takes those from the original results file.
 *
 * Unset, every judge runs. The javascript asserts cost nothing and always run.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

interface Assert {
  type: string;
  metric?: string;
}

export default function regradeTests(): Record<string, unknown>[] {
  const tests = parse(readFileSync(process.env.REGRADE_DATASET || 'datasets/vic-rentals.yaml', 'utf8'));
  // REGRADE_IDS (comma-separated case ids) re-judges just those cases, such as a hand-checked sample.
  const ids = (process.env.REGRADE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const picked = ids.length ? tests.filter((t: { metadata: { id: string } }) => ids.includes(t.metadata.id)) : tests;
  if (ids.length && picked.length !== ids.length) throw new Error(`REGRADE_IDS names cases the dataset lacks: ${ids.join(', ')}`);
  const only = (process.env.REGRADE_JUDGES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (only.length === 0) return picked;

  const known = new Set<string>();
  for (const t of picked) for (const a of (t.assert ?? []) as Assert[]) if (a.type === 'llm-rubric') known.add(a.metric ?? '');
  const unknown = only.filter((m) => !known.has(m));
  if (unknown.length) throw new Error(`REGRADE_JUDGES names ${unknown.join(', ')}; the dataset judges ${[...known].join(', ')}`);

  return picked.map((t: { assert?: Assert[] }) => ({
    ...t,
    assert: (t.assert ?? []).filter((a) => a.type !== 'llm-rubric' || only.includes(a.metric ?? '')),
  }));
}
