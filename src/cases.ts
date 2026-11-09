/**
 * Case compiler: `npm run cases`.
 *
 * cases/*.yaml (written by scripts/make-rental-cases.py from questions/; fields in
 * cases/README.md) is not a shape promptfoo reads, so this emits datasets/<name>.yaml in
 * promptfoo's native test format.
 *
 * The question is the only var. Everything the asserts read goes to `metadata`, which
 * reaches them as `context.test.metadata` and survives into the results file.
 *
 * Refusals, all hard errors rather than warnings:
 *   - a document_set the manifest does not know   bindProviders would refuse the run anyway
 *   - a judge question with no rubric             a generic stand-in rubric measures nothing
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { parse, stringify } from 'yaml';

import { rubricFor } from './rubrics.js';
import { corpusRef, loadManifest } from './setup.js';

export interface Case {
  id: string;
  /** The question's role in the study (date-sensitive, needs more facts, ...), slugified. */
  category: string;
  question: string;
  document_set: string;
  expected_documents: string[];
  expected_not_cited: string[];
  expects_citations: boolean;
  must_contain: string[][];
  must_not_contain: string[];
  judge_questions: string[];
  ground_truth_ref: unknown[];
  correct_answer_summary: string;
  wrong_answer_looks_like: string;
  /** Documents and versions the answer must name: the ones in force on the scenario date. */
  must_cite?: string[];
  /** Every instrument in the library with the version in force on the scenario date. */
  in_force?: string[];
  /**
   * In-force files that also print, under "Amendments Not in Operation", amendments not yet law
   * on the scenario date (one note each). Fills the version-cited rubric's warning; empty means
   * no warning.
   */
  not_in_operation?: string[];
  /** Anything else worth keeping in the results file; passed through to metadata. */
  extra?: Record<string, unknown>;
}

/**
 * String checks are `type: javascript` asserts with a `file://` value, which promptfoo loads
 * as a module. (A `transform: file://...` would instead be read as a bare function body.)
 */
const MUST_CONTAIN = 'file://dist/src/asserts/mustContain.js';
const MUST_NOT_CONTAIN = 'file://dist/src/asserts/mustNotContain.js';
/** The judge sees the answer text only, not the citations block or the retrieved passages. */
const ANSWER_ONLY = 'output.answer';

/**
 * The version-cited warning for a date whose in-force file prints amendments not yet in force.
 * The judge does not see the file, and without the warning it passes a rule quoted from that
 * section because the answer cites the in-force version for it. Grounded in the corpus rather
 * than the judge's memory: a general "fail rules you know came later" fails correct answers.
 */
function notInOperation(notes: string[]): string {
  if (notes.length === 0) return '';
  return `

On this date the in-force file also prints, at the back under "Amendments Not in Operation",
amendments that had been passed but were not yet law:

${notes.map((n) => `- ${n}`).join('\n')}

A rule found only there was not in force on this date, even though it is printed in the
in-force file. Applying it as the law, or as a step the user can take, is applying a later
version's rule and fails, even when the answer cites the in-force version for it.`;
}

/** Fill the case's fields into a rubric. */
function fillRubric(value: string, c: Case): string {
  const filled = value
    .replaceAll('{{question}}', c.question)
    .replaceAll('{{correct_answer_summary}}', c.correct_answer_summary.trim())
    .replaceAll('{{wrong_answer_looks_like}}', c.wrong_answer_looks_like.trim())
    .replaceAll('{{must_cite}}', (c.must_cite ?? []).map((m) => `- ${m}`).join('\n'))
    .replaceAll('{{in_force}}', (c.in_force ?? []).map((m) => `- ${m}`).join('\n'))
    .replaceAll('{{not_in_operation}}', notInOperation(c.not_in_operation ?? []));
  for (const key of ['must_cite', 'in_force'] as const) {
    if (value.includes(`{{${key}}}`) && (c[key] ?? []).length === 0) {
      throw new Error(`the version-cited rubric needs ${key}, and the case has none`);
    }
  }
  return filled;
}

export function compileCase(c: Case): Record<string, unknown> {
  const assert: Record<string, unknown>[] = [];

  // Deterministic string checks. One assert each, reading the groups from vars; they
  // normalise internally, because a model quoting the regulation verbatim emits the
  // non-breaking spaces and curly quotes the corpus carries.
  if ((c.must_contain ?? []).length > 0) {
    assert.push({ type: 'javascript', value: MUST_CONTAIN, metric: 'must_contain' });
  }
  if ((c.must_not_contain ?? []).length > 0) {
    assert.push({ type: 'javascript', value: MUST_NOT_CONTAIN, metric: 'must_not_contain' });
  }

  // One rubric per judge question, metric named for the question so the aggregate table
  // splits by failure mode rather than by case.
  for (const key of c.judge_questions ?? []) {
    const rubric = rubricFor(key);
    assert.push({
      type: 'llm-rubric',
      value: fillRubric(rubric.value, c),
      transform: ANSWER_ONLY,
      metric: key,
    });
  }

  // `question` is the only var: it is the prompt. Everything the asserts read goes in
  // metadata, because promptfoo expands an array VAR into one test case per element — five
  // must_not_contain terms silently became five tests — while metadata passes through
  // untouched. The guard below makes that unforgettable.
  const vars = { question: c.question };
  for (const [k, v] of Object.entries(vars)) {
    if (Array.isArray(v)) {
      throw new Error(
        `${c.id}: vars.${k} is an array. promptfoo would expand it into one test case per ` +
          'element, each seeing a single value. Put list-shaped fields in metadata.',
      );
    }
  }

  return {
    description: `${c.id} [${c.category}] ${c.question}`,
    vars,
    metadata: {
      // Read by the asserts via caseList/caseGroups/caseValue in src/asserts/helpers.ts.
      expected_documents: c.expected_documents,
      expected_not_cited: c.expected_not_cited,
      expects_citations: c.expects_citations,
      must_contain: c.must_contain,
      must_not_contain: c.must_not_contain,
      id: c.id,
      category: c.category,
      document_set: c.document_set,
      correct_answer_summary: c.correct_answer_summary.trim(),
      wrong_answer_looks_like: c.wrong_answer_looks_like.trim(),
      ...(c.must_cite ? { must_cite: c.must_cite } : {}),
      ...(c.in_force ? { in_force: c.in_force } : {}),
      ...(c.not_in_operation?.length ? { not_in_operation: c.not_in_operation } : {}),
      ...(c.extra ?? {}),
    },
    ...(assert.length > 0 ? { assert } : {}),
  };
}

export interface CompileResult {
  compiled: Record<string, unknown>[];
  skipped: { id: string; reason: string }[];
}

/**
 * A run binds every provider to one document set (bindProviders), so a case file must name
 * one set, and it must be a corpus the manifest knows. The run's config and EVAL_CORPUS pick
 * the same set; bindProviders refuses a mismatch.
 */
export function compile(cases: Case[], only?: string[], knownSets?: string[]): CompileResult {
  const compiled: Record<string, unknown>[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const known = knownSets ?? knownDocSets();
  const sets = [...new Set(cases.map((c) => c.document_set))];
  if (sets.length > 1) {
    throw new Error(`A case file must use one document_set; this one uses ${sets.join(', ')}.`);
  }

  for (const c of cases) {
    if (only && !only.includes(c.id)) {
      skipped.push({ id: c.id, reason: 'not selected' });
      continue;
    }
    if (!known.includes(c.document_set)) {
      throw new Error(
        `${c.id}: document_set ${c.document_set} is not a corpus in manifest/manifest.json ` +
          `(known: ${known.join(', ')}).`,
      );
    }
    try {
      compiled.push(compileCase(c));
    } catch (err) {
      // A missing rubric is not this case's fault alone; name the case so it is findable.
      throw new Error(`${c.id}: ${(err as Error).message}`);
    }
  }
  return { compiled, skipped };
}

function knownDocSets(): string[] {
  const manifest = loadManifest();
  return [manifest.corpus, ...(manifest.extra_corpora ?? [])].map((r) => corpusRef(manifest, r.doc_set).doc_set);
}

function main(argv: string[]): void {
  const onlyFlag = argv.indexOf('--only');
  const only = onlyFlag >= 0 ? argv[onlyFlag + 1]?.split(',') : undefined;
  const inputs = argv.filter((a) => a.endsWith('.yaml'));
  if (inputs.length === 0) {
    inputs.push('cases/vic-rentals.yaml', 'cases/vic-rentals-undated.yaml', 'cases/vic-rentals-heldout.yaml',
      'cases/vic-rentals-heldout-undated.yaml');
  }

  for (const input of inputs) {
    const cases = parse(readFileSync(input, 'utf8')) as Case[];
    const { compiled, skipped } = compile(cases, only);
    const out = resolve('datasets', basename(input));
    mkdirSync(resolve('datasets'), { recursive: true });
    writeFileSync(
      out,
      `# GENERATED by \`npm run cases\` from ${input}. Do not edit.\n` +
        stringify(compiled, { lineWidth: 0 }),
    );
    console.log(`${input} -> ${out}: ${compiled.length} case(s)`);
    for (const s of skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
  }
}

if (process.argv[1]?.endsWith('cases.js')) main(process.argv.slice(2));
