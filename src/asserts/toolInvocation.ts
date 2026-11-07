import { SEARCH_TOOL_NAME, asResponse, searchRan, type GradingResult } from './helpers.js';

/**
 * Primary metric: did the search tool run at all.
 *
 * `forced_tool_id` is deliberately unset on the provider — forcing search would make this
 * assertion vacuous.
 */
export default function toolInvocation(output: unknown): GradingResult {
  const res = asResponse(output);
  if (searchRan(res)) {
    return { pass: true, score: 1, reason: `${SEARCH_TOOL_NAME} was called` };
  }
  const called = (res.tool_calls ?? []).map((c) => c.tool_name);
  return {
    pass: false,
    score: 0,
    reason: `${SEARCH_TOOL_NAME} was not called. Tools called: ${called.join(', ') || 'none'}`,
  };
}
