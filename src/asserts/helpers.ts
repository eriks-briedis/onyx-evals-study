import type { ChatFullResponse, SearchDoc } from '../types.js';

/** The tool's NAME constant (search_tool.py:269), not the `SearchTool` in_code id. */
export const SEARCH_TOOL_NAME = 'internal_search';

export interface GradingResult {
  pass: boolean;
  score: number;
  reason: string;
}

export function asResponse(output: unknown): ChatFullResponse {
  if (typeof output === 'string') {
    try {
      return JSON.parse(output) as ChatFullResponse;
    } catch {
      throw new Error(`Provider output was a non-JSON string: ${output.slice(0, 200)}`);
    }
  }
  if (!output || typeof output !== 'object') {
    throw new Error(`Provider output was ${typeof output}, expected ChatFullResponse`);
  }
  return output as ChatFullResponse;
}

/**
 * Every document the turn actually saw.
 *
 * `top_documents` alone is not enough: it is populated only from
 * AgentResponseStart.final_documents (process_message.py:2215) and is `[]` on turns where
 * search ran but no final document list was emitted. The per-tool `search_docs` cover
 * that case, so retrieval assertions must read the union.
 */
export function retrievedDocs(res: ChatFullResponse): SearchDoc[] {
  const seen = new Map<string, SearchDoc>();
  for (const doc of res.top_documents ?? []) seen.set(doc.document_id, doc);
  for (const call of res.tool_calls ?? []) {
    for (const doc of call.search_docs ?? []) seen.set(doc.document_id, doc);
  }
  return [...seen.values()];
}

export function searchRan(res: ChatFullResponse): boolean {
  return (res.tool_calls ?? []).some((c) => c.tool_name === SEARCH_TOOL_NAME);
}

export function toList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read a case field, preferring `metadata` over `vars`.
 *
 * **Never put a list in `vars`.** promptfoo expands an array var into one test case per
 * element — five `must_not_contain` terms became five tests, each seeing a single string,
 * and a one-element array arrives as a bare scalar. `metadata` is passed through untouched
 * and does not multiply the case. Verified against promptfoo 0.122.2.
 */
export function caseValue(context: any, key: string): unknown {
  const meta = context?.test?.metadata;
  if (meta && meta[key] !== undefined) return meta[key];
  return context?.vars?.[key];
}

/** A case field as a list of strings, however it arrived. */
export function caseList(context: any, key: string): string[] {
  const value = caseValue(context, key);
  return Array.isArray(value) ? value.map(String) : toList(value);
}

/** A case field as any-of groups: `[["a", "b"], ["c"]]`. */
export function caseGroups(context: any, key: string): string[][] {
  const value = caseValue(context, key);
  if (!Array.isArray(value)) {
    const flat = toList(value);
    return flat.length > 0 ? [flat] : [];
  }
  return value.map((g) => (Array.isArray(g) ? g.map(String) : [String(g)]));
}
