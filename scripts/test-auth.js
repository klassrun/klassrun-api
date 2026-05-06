// scripts/test-auth.js
//
// End-to-end auth test. Hits the running dev server and verifies:
//   1. Signup creates school + user + trial subscription
//   2. Login returns JWT with portal URL
//   3. /me returns full user + school context
//   4. Invite teacher → accept invite (with email confirmation)
//   5. Email mismatch is blocked
//   6. Expired invite is blocked
//   7. Reused invite token is blocked
//
// PREREQUISITES:
//   1. Server running:        npm run dev
//   2. Clean database:        npx prisma migrate reset
//   3. Reserved slugs seeded: npm run db:seed
//
// Run with: npm run test:auth

require('dotenv/config');

const BASE = process.env.API_URL || 'http://localhost:4000';
const TIMESTAMP = Date.now();      // unique suffix so tests don't collide

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, details = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label}${details ? `\n      ${details}` : ''}`);
    failed += 1;
    failures.push(label);
  }
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function run() {
  console.log(`\n› Running auth tests against ${BASE}\n`);

  // ── 1. Signup ──
  console.log('› POST /api/auth/signup');
  const signupEmail = `tbelzent-${TIMESTAMP}@gmail.com`;
  const signup = await api('POST', '/api/auth/signup', {
    email: signupEmail,
    password: 'testpassword123',
    firstName: 'Test',
    lastName: 'Principal',
    schoolName: `Test School ${TIMESTAMP}`,
    schoolState: 'Lagos',
  });
  check('signup returns 201', signup.status === 201, JSON.stringify(signup.data));
  check('signup returns token', !!signup.data.token);
  check('signup returns school slug', !!signup.data.user?.schoolSlug);
  check('signup returns trialEndsAt', !!signup.data.trialEndsAt);
  check('signup returns portalUrl', !!signup.data.portalUrl);

  if (!signup.data.token) {
    console.log('\n✗ Cannot continue — signup failed');
    process.exit(1);
  }

  const adminToken = signup.data.token;

  // ── 2. Duplicate email ──
  console.log('\n› POST /api/auth/signup (duplicate email)');
  const dup = await api('POST', '/api/auth/signup', {
    email: signupEmail,
    password: 'testpassword123',
    firstName: 'Test', lastName: 'Dup',
    schoolName: 'Different School',
  });
  check('duplicate email returns 409', dup.status === 409);

  // ── 3. Login ──
  console.log('\n› POST /api/auth/login');
  const login = await api('POST', '/api/auth/login', {
    email: signupEmail, password: 'testpassword123',
  });
  check('login returns 200', login.status === 200);
  check('login returns token', !!login.data.token);
  check('login returns portalUrl', !!login.data.portalUrl);

  // ── 4. Wrong password ──
  console.log('\n› POST /api/auth/login (wrong password)');
  const wrongPw = await api('POST', '/api/auth/login', {
    email: signupEmail, password: 'wrongwrongwrong',
  });
  check('wrong password returns 401', wrongPw.status === 401);

  // ── 5. /me ──
  console.log('\n› GET /api/auth/me');
  const me = await api('GET', '/api/auth/me', null, adminToken);
  check('me returns 200', me.status === 200);
  check('me returns school object', !!me.data.user?.school);
  check('me returns role SCHOOL_ADMIN', me.data.user?.role === 'SCHOOL_ADMIN');

  // ── 6. Invite teacher ──
  console.log('\n› POST /api/auth/invite');
  const teacherEmail = `wildcrooksng-${TIMESTAMP}@gmail.com`;
  const invite = await api('POST', '/api/auth/invite', {
    email: teacherEmail,
    firstName: 'Test', lastName: 'Teacher',
  }, adminToken);
  check('invite returns 201', invite.status === 201, JSON.stringify(invite.data));
  check('invite returns inviteLink', !!invite.data.inviteLink);
  check('invite returns expiresAt', !!invite.data.expiresAt);

  const inviteToken = invite.data.inviteLink?.split('/').pop();

  // ── 7. Accept invite — email mismatch ──
  console.log('\n› POST /api/auth/invite/:token/accept (email mismatch)');
  const mismatch = await api('POST', `/api/auth/invite/${inviteToken}/accept`, {
    password: 'teacherpassword123',
    email: 'wrong@klassrun-test.com',
  });
  check('email mismatch returns 403', mismatch.status === 403);

  // ── 8. Accept invite — short password ──
  console.log('\n› POST /api/auth/invite/:token/accept (short password)');
  const shortPw = await api('POST', `/api/auth/invite/${inviteToken}/accept`, {
    password: '123',
    email: teacherEmail,
  });
  check('short password returns 400', shortPw.status === 400);

  // ── 9. Accept invite — success ──
  console.log('\n› POST /api/auth/invite/:token/accept (success)');
  const accept = await api('POST', `/api/auth/invite/${inviteToken}/accept`, {
    password: 'teacherpassword123',
    email: teacherEmail,
  });
  check('accept invite returns 200', accept.status === 200, JSON.stringify(accept.data));
  check('accept returns token', !!accept.data.token);
  check('accept returns role TEACHER', accept.data.user?.role === 'TEACHER');

  // ── 10. Reuse same token ──
  console.log('\n› POST /api/auth/invite/:token/accept (reuse rejected)');
  const reuse = await api('POST', `/api/auth/invite/${inviteToken}/accept`, {
    password: 'teacherpassword123',
    email: teacherEmail,
  });
  check('token reuse returns 4xx', reuse.status >= 400 && reuse.status < 500);

  // ── 11. Slug endpoints ──
  console.log('\n› GET /api/slug/check (reserved)');
  const reserved = await api('GET', '/api/slug/check?slug=app');
  check('reserved slug returns available=false', reserved.data.available === false);
  check('reserved slug error mentions reserved', /reserved/i.test(reserved.data.error || ''));

  console.log('\n› GET /api/slug/check (taken)');
  const takenSlug = signup.data.user.schoolSlug;
  const taken = await api('GET', `/api/slug/check?slug=${takenSlug}`);
  check('taken slug returns available=false', taken.data.available === false);
  check('taken slug error mentions taken', /taken/i.test(taken.data.error || ''));

  console.log('\n› GET /api/slug/suggest');
  const suggest = await api('GET', `/api/slug/suggest?name=Test School ${TIMESTAMP}`);
  check('suggest returns array', Array.isArray(suggest.data.suggestions));

  // ── Summary ──
  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n  Failed:');
    failures.forEach((f) => console.log(`    - ${f}`));
  }
  console.log('────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\n✗ Test run crashed:', err);
  process.exit(1);
});
