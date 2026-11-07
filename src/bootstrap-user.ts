/**
 * Create the dedicated eval user: `npm run bootstrap`.
 *
 * Service-account API keys (`POST /admin/api-key`) sit behind the Business tier gate
 * (ee/onyx/server/middleware/tier_gate.py), so a Community deployment cannot mint one.
 * Password login is never gated — `/auth` and `/manage/admin/users` are both in
 * LICENSE_ENFORCEMENT_ALLOWED_PREFIXES — so the suite authenticates as a dedicated user
 * instead.
 *
 * A separate account matters: the setup hook wipes the calling user's name, role,
 * memories and preferences, which would be destructive against a human's account.
 *
 * Needs an existing admin's credentials once, to grant the new user admin. Reads them
 * from ONYX_ADMIN_EMAIL / ONYX_ADMIN_PASSWORD, or prompts.
 */
import { stdin, stdout } from 'node:process';

import { OnyxClient, OnyxError } from './onyx.js';

const baseUrl = process.env.ONYX_BASE_URL;
if (!baseUrl) {
  console.error('FAIL: ONYX_BASE_URL must be set. See .env.example.');
  process.exit(1);
}

const evalEmail = process.env.ONYX_EVAL_USER_EMAIL ?? 'onyx-evals@example.com';
const evalPassword = process.env.ONYX_EVAL_USER_PASSWORD;
if (!evalPassword) {
  console.error(
    'FAIL: ONYX_EVAL_USER_PASSWORD must be set — choose one and put it in .env,\n' +
      '      alongside ONYX_EVAL_USER_EMAIL.',
  );
  process.exit(1);
}

/**
 * Read one line from a raw-mode terminal, echoing it or not.
 *
 * One mechanism for both prompts, deliberately. Mixing `readline` (which puts the tty in
 * its own mode and restores it on close) with a raw-mode secret prompt loses the race:
 * readline's restore re-enables the terminal's echo after raw mode is set, and the
 * password lands on screen in clear text. Verified: that ordering leaked, this does not.
 */
function promptRaw(query: string, mask: boolean): Promise<string> {
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdout.write(query);

    let buf = '';
    const finish = (value: string | null) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (value === null) process.exit(130); // Ctrl-C
      resolve(value);
    };

    const onData = (chunk: string) => {
      // A paste arrives as a single chunk, so walk it character by character.
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(buf.trim());
        if (ch === '\u0003') return finish(null);
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            if (!mask) stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          buf += ch;
          if (!mask) stdout.write(ch);
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(
  envVar: string,
  query: string,
  mask = false,
): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  if (stdin.isTTY !== true) {
    console.error(
      `FAIL: ${envVar} is not set and stdin is not a terminal, so it cannot be prompted for.\n` +
        `      Set ${envVar} in the environment, or run this in an interactive shell.`,
    );
    process.exit(1);
  }
  return promptRaw(query, mask);
}

const adminEmail = await ask('ONYX_ADMIN_EMAIL', 'Onyx admin email: ');
const adminPassword = await ask('ONYX_ADMIN_PASSWORD', 'Onyx admin password: ', true);

const admin = new OnyxClient(baseUrl, {
  kind: 'password',
  email: adminEmail,
  password: adminPassword,
});

try {
  await admin.login();
} catch (err) {
  const status = err instanceof OnyxError ? ` (HTTP ${err.status})` : '';
  console.error(`FAIL: admin login failed${status}. Check the email and password.`);
  process.exit(1);
}

const me = await admin.getMe();
if (!(me.effective_permissions ?? []).includes('admin')) {
  console.error(`FAIL: ${me.email} is not an admin, so it cannot grant admin access.`);
  process.exit(1);
}
console.log(`admin:     ${me.email}`);

let created: boolean;
try {
  ({ created } = await admin.register(evalEmail, evalPassword));
} catch (err) {
  if (err instanceof OnyxError && err.status === 422) {
    // email-validator rejects special-use domains: arpa, invalid, local, localhost,
    // onion, test. `example.com` is RFC 2606 reserved, so it passes validation and can
    // never collide with a real mailbox.
    console.error(
      `FAIL: Onyx rejected "${evalEmail}" as an email address.\n` +
        '      Domains ending in .local, .localhost, .test, .invalid, .arpa or .onion are\n' +
        '      refused. Set ONYX_EVAL_USER_EMAIL to something like onyx-evals@example.com.',
    );
    process.exit(1);
  }
  if (err instanceof OnyxError && err.status === 400) {
    console.error(
      `FAIL: registration refused for ${evalEmail} (HTTP 400): ${err.body.slice(0, 200)}\n` +
        '      A password shorter than 8 characters is the usual cause.',
    );
    process.exit(1);
  }
  throw err;
}
console.log(`eval user: ${evalEmail} ${created ? '(created)' : '(already existed)'}`);

await admin.setAdminAccess(evalEmail, true);
console.log('admin access granted');

// Prove it end to end: log in as the eval user and confirm the permission landed.
const evalClient = new OnyxClient(baseUrl, {
  kind: 'password',
  email: evalEmail,
  password: evalPassword,
});
const evalMe = await evalClient.getMe();
const perms = evalMe.effective_permissions ?? [];
if (!perms.includes('admin')) {
  console.error(`FAIL: ${evalEmail} still lacks admin (permissions: ${perms.join(', ')})`);
  process.exit(1);
}

console.log(`verified:  ${evalMe.email} has ${perms.join(', ')}`);
console.log('\nDone. Put these in .env, then run `npm run verify`:');
console.log(`  ONYX_EVAL_USER_EMAIL=${evalEmail}`);
console.log('  ONYX_EVAL_USER_PASSWORD=<the password you chose>');
