/**
 * Unit tests for the case compiler and the string checks it wires up.
 *
 * No Onyx and no network: these run against fabricated ChatFullResponse fixtures. What they
 * pin down is the part that would otherwise only be discovered mid-run — that a `contains`
 * survives the corpus's typography, and that the compiler refuses what it must refuse.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compile, compileCase, type Case } from '../src/cases.js';
import mustContain from '../src/asserts/mustContain.js';
import mustNotContain from '../src/asserts/mustNotContain.js';
import { normaliseText } from '../src/asserts/normalise.js';
import type { ChatFullResponse } from '../src/types.js';

function response(over: Partial<ChatFullResponse> = {}): ChatFullResponse {
  return {
    answer: 'an answer',
    answer_citationless: '',
    pre_answer_reasoning: null,
    tool_calls: [],
    top_documents: [],
    citation_info: [],
    message_id: 1,
    chat_session_id: 's',
    incognito: false,
    error_msg: null,
    ...over,
  };
}

const baseCase: Case = {
  id: 'vr-test-2026-01-01', category: 'date-sensitive', question: 'Q?',
  document_set: 'vic-rentals-baseline', expected_documents: ['a.pdf'], expected_not_cited: [],
  expects_citations: true, must_contain: [['x']], must_not_contain: [],
  judge_questions: ['must-mention'], ground_truth_ref: [],
  correct_answer_summary: 'the point', wrong_answer_looks_like: 'not the point',
};

describe('normalisation', () => {
  it('folds the corpus typography that breaks a naive contains', () => {
    // Article 33(1) as it sits in the regulation markdown: non-breaking spaces, from EUR-Lex.
    const quoted = 'notify within 72 hours under Article 55';
    assert.ok(!quoted.includes('72 hours'), 'fixture must actually contain the NBSP');
    assert.ok(normaliseText(quoted).includes('72 hours'));
    assert.ok(normaliseText(quoted).includes('Article 55'));
  });

  it('folds curly quotes and dashes', () => {
    assert.equal(normaliseText('‘renter’ – the renters’ rights'),
      "'renter' - the renters' rights");
  });

  it('is applied by the string asserts, against the answer', () => {
    // The answer quotes Article 33 verbatim, so it carries EUR-Lex's non-breaking spaces.
    const res = response({ answer: 'notify within 72 hours' });
    const ctx = { vars: { must_contain: [['72 hours']] } };
    assert.ok(!res.answer.includes('72 hours'), 'fixture must actually contain the NBSP');
    assert.equal(mustContain(res, ctx).pass, true);
    assert.equal(mustContain(JSON.stringify(res), ctx).pass, true, 'string output too');
  });
});

describe('compiler', () => {
  it('keeps every list out of vars: promptfoo expands array vars into extra test cases', () => {
    const out = compileCase({ ...baseCase, expected_documents: ['a.pdf', 'b.pdf'] }) as any;
    assert.deepEqual(Object.keys(out.vars), ['question'],
      'question is the prompt; everything else is metadata');
    for (const [k, v] of Object.entries(out.vars)) {
      assert.ok(!Array.isArray(v), `vars.${k} is an array and would multiply the case`);
    }
    assert.deepEqual(out.metadata.expected_documents, ['a.pdf', 'b.pdf']);
    assert.equal(out.metadata.id, 'vr-test-2026-01-01');
    assert.equal(out.metadata.correct_answer_summary, 'the point');
  });

  it('reads lists back through the assert helpers, from metadata', () => {
    const out = compileCase({ ...baseCase, must_contain: [['x', 'y']],
      must_not_contain: ['no'] }) as any;
    const ctx = { test: { metadata: out.metadata }, vars: out.vars };
    assert.equal(mustContain(response({ answer: 'has y in it' }), ctx).pass, true);
    assert.equal(mustNotContain(response({ answer: 'says no here' }), ctx).pass, false);
  });

  it('names each metric for its judge question, and shows the judge the answer only', () => {
    const out = compileCase({ ...baseCase, judge_questions: ['must-mention', 'must-not-say'] }) as any;
    const metrics = out.assert.map((a: any) => a.metric);
    assert.deepEqual(metrics, ['must_contain', 'must-mention', 'must-not-say']);
    // the string check must be a module assert, not a transform (see src/cases.ts)
    assert.equal(out.assert[0].type, 'javascript');
    assert.equal(out.assert[1].transform, 'output.answer');
  });

  it('fills the case into the rubric', () => {
    const out = compileCase(baseCase) as any;
    const rubric = out.assert.find((a: any) => a.metric === 'must-mention').value;
    assert.match(rubric, /The user asked: Q\?/);
    assert.match(rubric, /the point/);
    assert.doesNotMatch(rubric, /\{\{/);
  });

  it('refuses a document set the manifest has no corpus for', () => {
    assert.throws(() => compile([{ ...baseCase, document_set: 'vic-rentals-unknown' }]),
      /is not a corpus in manifest/);
  });

  it('refuses a case file that mixes document sets', () => {
    assert.throws(() => compile([baseCase, { ...baseCase, id: 'vr-test-2026-01-02', document_set: 'vic-rentals-asof-2025-10-01' }]),
      /must use one document_set/);
  });

  it('fills must_cite and in_force into the version-cited rubric, and refuses it without them', () => {
    const c = { ...baseCase, document_set: 'vic-rentals-baseline', judge_questions: ['version-cited'],
      must_cite: ['Residential Tenancies Act 1997, Authorised Version No. 110'],
      in_force: ['Residential Tenancies Regulations 2021, Authorised Version No. 004'] };
    const asserts = compile([c]).compiled[0]!.assert as { type: string; metric: string; value: string }[];
    const rubric = asserts.find((a) => a.metric === 'version-cited');
    assert.match(rubric!.value, /- Residential Tenancies Act 1997, Authorised Version No. 110/);
    assert.match(rubric!.value, /- Residential Tenancies Regulations 2021, Authorised Version No. 004/);
    assert.throws(() => compile([{ ...c, must_cite: [] }]), /needs must_cite/);
    assert.throws(() => compile([{ ...c, in_force: [] }]), /needs in_force/);
  });

  it('refuses a judge question with no rubric written', () => {
    assert.throws(() => compile([{ ...baseCase, judge_questions: ['unsupported-claim'] }]),
      /No rubric written for judge question "unsupported-claim"/);
  });
});
