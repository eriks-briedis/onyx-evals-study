/**
 * Deterministic string check: no `must_not_contain` term appears in the answer.
 *
 * These terms are chosen to be evidence of a specific failure, not general bad words — the
 * unedited "under any circumstances" in a counterfactual case, a memorised fine amount, a
 * document number from the wrong file. Normalised the same way as mustContain, and for the
 * same reason.
 */
import { asResponse, caseList, type GradingResult } from './helpers.js';
import { normaliseText } from './normalise.js';

export default function mustNotContain(output: unknown, context: any): GradingResult {
  const terms = caseList(context, 'must_not_contain');
  if (terms.length === 0) {
    return { pass: true, score: 1, reason: 'No must_not_contain terms declared' };
  }
  const answer = normaliseText(asResponse(output).answer ?? '').toLowerCase();
  const present = terms.filter((t) => answer.includes(normaliseText(t).toLowerCase()));
  if (present.length > 0) {
    return {
      pass: false,
      score: 0,
      reason: `Answer contains forbidden term(s): ${present.map((t) => JSON.stringify(t)).join(', ')}`,
    };
  }
  return { pass: true, score: 1, reason: `None of the ${terms.length} forbidden term(s) present` };
}
