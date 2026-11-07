/**
 * `npm run filters -- on|off`: switches Onyx's inferred search filters for the workspace.
 *
 * Runs declare the condition with EVAL_AUTO_FILTERS and the beforeAll hook only checks it,
 * so a run never changes a workspace setting behind the operator's back.
 */
import { clientFromEnv } from './setup.js';

const want = process.argv[2];
if (want !== 'on' && want !== 'off') {
  console.error('Usage: npm run filters -- on|off');
  process.exit(1);
}
const onyx = clientFromEnv();
const after = await onyx.patchWorkspaceSettings({ auto_detect_search_filters: want === 'on' });
console.log(`auto_detect_search_filters is ${after.auto_detect_search_filters !== false ? 'on' : 'off'}`);
