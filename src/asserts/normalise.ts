/**
 * Answer normalisation, used by the deterministic string asserts.
 *
 * The PDF extractions carry typography that defeats naive matching: curly quotes, en and em
 * dashes, non-breaking spaces. A model quoting the law verbatim emits the same characters, so
 * a `contains` on text it copied correctly would silently miss.
 *
 * Normalising the ANSWER is safe. Normalising a ground-truth quote is not, which is why
 * scripts/make-rental-cases.py matches those byte-exact against the corpus text instead — a
 * normalised quote no longer proves the passage is there.
 *
 * Judged assertions do not use this. An LLM reading a curly quote is unbothered; the
 * problem is substring matching, and only substring matching.
 */
export function normaliseText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[   ]/g, ' ')
    .replace(/[‘’‛′´]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[ \t]+/g, ' ');
}
