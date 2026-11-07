/**
 * Judge rubrics. Each is one Yes/No question; the judge answers with a one-sentence reason
 * quoting the answer, and promptfoo's `llm-rubric` handles the grading contract.
 *
 * Together the three are the pass/fail rule each gold slot was written against
 * (questions/<ID>/README.md): every "must mention" point covered, nothing on the "must not
 * say" list, and the documents named in the version in force on the question's date.
 *
 * A judge question with no rubric here is a hard error in the compiler: a generic stand-in
 * would be a score that measures nothing in particular.
 */
export interface Rubric {
  /**
   * Judge prompt. `{{question}}`, `{{correct_answer_summary}}`, `{{wrong_answer_looks_like}}`,
   * `{{must_cite}}` and `{{in_force}}` are filled from the case.
   */
  value: string;
}

export const RUBRICS: Record<string, Rubric> = {
  'must-mention': {
    value: `The user asked: {{question}}

Pass only if the answer states every one of these points:

{{correct_answer_summary}}

Different wording, extra correct material and a longer answer are all fine. A point counts as
missing if it is absent, stated with a material change of meaning, or hedged so far that a
reader could not tell which way it falls. Where a point offers alternatives ("at least one
of"), any one of them is enough. A point that the law does not say or require something is
covered by an answer saying the documents do not say or require it. Where a point lists next
steps, they are examples: any reasonable next step consistent with the law counts.

Answer Yes (pass) or No (fail), then one sentence of reason naming the missing point, or
quoting the words that cover the hardest one.`,
  },

  'must-not-say': {
    value: `The user asked: {{question}}

Fail if the answer says any of the following, in any words:

{{wrong_answer_looks_like}}

Judge what the answer asserts, not what it mentions in order to reject. An answer that
raises one of these only to say it is wrong, or that it applies on a different date, has not
said it.

Answer Yes (pass, none of them said) or No (fail), then one sentence of reason quoting the
words that say it.`,
  },

  'version-cited': {
    value: `The user asked: {{question}}

The question is set on a specific date. The answer should rest on these documents, in the
version in force on that date:

{{must_cite}}

For every document in the library, this is the version in force on that date:

{{in_force}}

Pass if the answer names every document in the first list together with its version, and
every document version it relies on for a rule it applies is the one in force on that date.
Citing another document's in-force version is fine.

Fail if it leaves out a document in the first list or names it without a version, or if it applies a rule taken from a version that was not
in force on that date (an earlier or later version of the same document). Mentioning another
version only to say the law was different earlier or changes later is not relying on it.
Presenting another version's rule as the law or as a step the user can take is relying on it,
even with a caveat that it may not apply on that date. The test: if everything sourced from
the other version were deleted, would the answer's substance change?

A version can be named as "Authorised Version No. 110" or "version 110", by a file name such
as rta-1997-v110-2025-08-06.pdf, or by a legislation.vic.gov.au link: in 97-109aa110 the
Act's version is 110, in 21-3sra005 the Regulations' version is 005, and in 23-10sra002 the
Rooming House Standards Regulations' version is 002. A version can also be named by its date
("the version dated 6 August 2025", "as at 6 August 2025") when that is the date shown above.

Answer Yes (pass) or No (fail), then one sentence of reason quoting the version the answer
names.`,
  },
};

export function rubricFor(key: string): Rubric {
  const r = RUBRICS[key];
  if (!r) {
    throw new Error(
      `No rubric written for judge question "${key}". Add one to src/rubrics.ts.\n` +
        `Known: ${Object.keys(RUBRICS).join(', ')}.`,
    );
  }
  return r;
}
