import { asResponse, caseList, retrievedDocs, type GradingResult } from './helpers.js';

/**
 * Primary metric: were the expected documents retrieved.
 *
 * Matches on `semantic_identifier` (the filename), which is stable. `document_id` is not:
 * file connectors mint `FILE_CONNECTOR__<uuid>` fresh on every re-seed.
 *
 * Reads `context.vars.expected_documents`, scored as the fraction found.
 */
export default function retrieval(output: unknown, context: any): GradingResult {
  const res = asResponse(output);
  const expected = caseList(context, 'expected_documents');
  const docs = retrievedDocs(res);
  const identifiers = docs.map((d) => d.semantic_identifier);

  if (expected.length === 0) {
    return docs.length > 0
      ? { pass: true, score: 1, reason: `No expectation set; retrieved ${docs.length} documents` }
      : { pass: false, score: 0, reason: 'No documents retrieved' };
  }

  const found = expected.filter((e) => identifiers.some((id) => id === e || id.includes(e)));
  const score = found.length / expected.length;
  return {
    pass: score === 1,
    score,
    reason:
      score === 1
        ? `All ${expected.length} expected documents retrieved`
        : `Retrieved ${found.length}/${expected.length}. Missing: ` +
          `${expected.filter((e) => !found.includes(e)).join(', ')}. ` +
          `Saw: ${identifiers.join(', ') || 'none'}`,
  };
}
