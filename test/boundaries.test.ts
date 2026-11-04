/**
 * Structural rules. Each one would otherwise be a sentence in a README that an agent never reads.
 * They're cheap source scans; they fail the build when a rule is broken.
 */
import { describe, test } from 'bun:test';

describe('hard constraints', () => {
  test.todo('no source file mentions usage-queue, LPOP, or SUBSCRIBE (never consume CPA usage)');
  test.todo('no source file sends DELETE to /auth-files (out of scope for v1)');
  test.todo('keeper.ts SQL strings start with SELECT or PRAGMA query_only; the Database is opened { readonly: true }');
  test.todo('fetch( appears only in server/cpa.ts (the one transport that holds the key) and ui/api.ts');
  test.todo('Bun.serve hostname is the literal 127.0.0.1');
});

describe('layering', () => {
  test.todo('src/ui/** never imports src/server/**');
  test.todo('src/shared/** imports nothing outside src/shared/ except zod (it runs in the browser)');
  test.todo('src/ui/components/** never imports shared/domain Snapshot or shared/derive (render from view.ts)');
  test.todo('wire schemas (Wire*) are not exported from cpa.ts or anthropic.ts');
});

describe('secrets', () => {
  test.todo('parseRefresh on a body with auth.access_token/refresh_token returns exactly { ok: true }; JSON has no token text');
  test.todo('JSON.stringify(ManagementKey.from("k")) and String(key) are "[redacted]"');
  test.todo('every handler output, serialized, contains no field named token, access_token, or refresh_token');
});
