import { asResponse, caseList, caseValue, retrievedDocs, searchRan, type GradingResult } from './helpers.js';

/**
 * Primary metric, structural half: every citation points at a document the turn actually
 * retrieved, and a grounded answer carries at least one citation.
 *
 * "Grounded" is the important qualifier. A correct refusal — the model searched, found
 * nothing relevant, and said so — legitimately cites nothing, and failing it would push
 * the eval toward rewarding answers that cite irrelevant documents to look grounded.
 * Citations are therefore required only when the case declares `expected_documents`;
 * `expects_citations` overrides that explicitly.
 *
 * Claim-level fidelity — does the cited document actually support the sentence — is a
 * rubric, and lands with the goldens.
 */
export default function citationSupport(output: unknown, context: any): GradingResult {
  const res = asResponse(output);
  const citations = res.citation_info ?? [];
  const known = new Set(retrievedDocs(res).map((d) => d.document_id));

  const dangling = citations.filter((c) => !known.has(c.document_id));
  if (dangling.length > 0) {
    return {
      pass: false,
      score: 0,
      reason:
        `${dangling.length} citation(s) reference documents that were never retrieved: ` +
        dangling.map((c) => `[${c.citation_number}] ${c.document_id}`).join(', '),
    };
  }

  const declared = caseValue(context, 'expects_citations');
  const expectsCitations =
    declared === undefined ? caseList(context, 'expected_documents').length > 0 : Boolean(declared);

  if (expectsCitations && searchRan(res) && known.size > 0 && citations.length === 0) {
    const hasMarker = /\[+\d+\]+/.test(res.answer ?? '');
    return {
      pass: false,
      score: 0,
      reason: hasMarker
        ? 'Answer has [n] markers but citation_info is empty'
        : 'Search retrieved documents but the answer cites none of them',
    };
  }

  return {
    pass: true,
    score: 1,
    reason: expectsCitations
      ? `${citations.length} citation(s), all resolving to retrieved documents`
      : `${citations.length} citation(s); none required for this case`,
  };
}
