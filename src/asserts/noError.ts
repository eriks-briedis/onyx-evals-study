import { asResponse, type GradingResult } from './helpers.js';

/** A turn that returned `error_msg` is not a low score, it is an invalid case. */
export default function noError(output: unknown): GradingResult {
  const res = asResponse(output);
  if (res.error_msg) {
    return { pass: false, score: 0, reason: `Onyx returned error_msg: ${res.error_msg}` };
  }
  if (!res.answer || res.answer.trim() === '') {
    return { pass: false, score: 0, reason: 'Answer was empty' };
  }
  return { pass: true, score: 1, reason: 'No error, non-empty answer' };
}
