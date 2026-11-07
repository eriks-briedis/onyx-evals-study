/**
 * Deterministic string check: every `must_contain` group is satisfied by the answer.
 *
 * A group is an any-of: `[["05/2020", "2020"]]` passes if either string is present. All
 * groups must pass.
 *
 * This is a javascript assert rather than promptfoo's native `contains-any` plus a
 * transform, because a `transform: file://...` inside an external tests file does not work:
 * promptfoo dereferences the `file://` into the file's source text and then evaluates it
 * with `new Function`, which fails on any ESM module. A `type: javascript` assert with a
 * `file://` value is loaded as a real module and is fine. Verified against promptfoo
 * 0.122.2 with the echo provider.
 */
import { asResponse, caseGroups, type GradingResult } from './helpers.js';
import { normaliseText } from './normalise.js';

export default function mustContain(output: unknown, context: any): GradingResult {
  const groups = caseGroups(context, 'must_contain');
  if (groups.length === 0) {
    return { pass: true, score: 1, reason: 'No must_contain groups declared' };
  }
  const answer = normaliseText(asResponse(output).answer ?? '').toLowerCase();
  const missing = groups.filter(
    (group) => !group.some((term) => answer.includes(normaliseText(term).toLowerCase())),
  );
  if (missing.length > 0) {
    return {
      pass: false,
      score: 0,
      reason:
        `${missing.length}/${groups.length} group(s) absent from the answer: ` +
        missing.map((g) => `any of [${g.join(' | ')}]`).join('; '),
    };
  }
  return { pass: true, score: 1, reason: `All ${groups.length} must_contain group(s) present` };
}
