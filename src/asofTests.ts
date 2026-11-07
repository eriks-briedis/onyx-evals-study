/**
 * The tests of the perfect-filter arm (promptfooconfig.rentals-asof.yaml): datasets/vic-rentals.yaml,
 * each pointed at the document set holding only the law versions in force on its scenario date
 * (scripts/build-asof-corpora.py). The provider body sends `document_set: ['{{as_of_doc_set}}']`,
 * so search can only return the right version.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export const AS_OF_PREFIX = 'vic-rentals-asof-';

export default function asofTests(): Record<string, unknown>[] {
  const tests = parse(readFileSync('datasets/vic-rentals.yaml', 'utf8'));
  return tests.map((t: { vars: Record<string, unknown>; metadata: Record<string, unknown> }) => {
    // The case id ends in the scenario date: vr-<question>-<yyyy-mm-dd>.
    const set = AS_OF_PREFIX + String(t.metadata.id).slice(-10);
    return { ...t, vars: { ...t.vars, as_of_doc_set: set }, metadata: { ...t.metadata, document_set: set } };
  });
}
