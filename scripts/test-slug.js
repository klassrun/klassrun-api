// scripts/test-slug.js
// Quick sanity check for the slug utility module.
// Run with: node scripts/test-slug.js
//
// This is a lightweight test runner — no Jest, no test framework yet.
// We'll add a real test framework later in Phase 1.

require('dotenv/config');
const slug = require('../src/utils/slug');

let passed = 0;
let failed = 0;

function check(label, condition, details = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label}${details ? `\n      ${details}` : ''}`);
    failed += 1;
  }
}

async function run() {
  // ─── generateFromName ──────────────────────────────────────────────────
  console.log('\n› generateFromName');
  check(
    'converts simple name',
    slug.generateFromName('Greenfield Academy') === 'greenfield-academy',
    `got: "${slug.generateFromName('Greenfield Academy')}"`
  );
  check(
    'strips punctuation',
    slug.generateFromName("Kings' College, Lagos") === 'kings-college-lagos'
  );
  check(
    'collapses multiple spaces',
    slug.generateFromName('  Multiple   Spaces  ') === 'multiple-spaces'
  );
  check(
    'handles accents',
    slug.generateFromName('Café International') === 'cafe-international'
  );
  check(
    'returns empty for empty input',
    slug.generateFromName('') === ''
  );
  check(
    'returns empty for non-string',
    slug.generateFromName(null) === ''
  );

  // ─── validate ──────────────────────────────────────────────────────────
  console.log('\n› validate');
  check(
    'accepts valid slug',
    slug.validate('greenfield-academy').valid === true
  );
  check(
    'rejects too short',
    slug.validate('ab').valid === false
  );
  check(
    'rejects too long',
    slug.validate('a'.repeat(50)).valid === false
  );
  check(
    'rejects leading hyphen',
    slug.validate('-greenfield').valid === false
  );
  check(
    'rejects trailing hyphen',
    slug.validate('greenfield-').valid === false
  );
  check(
    'rejects consecutive hyphens',
    slug.validate('green--field').valid === false
  );
  check(
    'rejects uppercase',
    slug.validate('Greenfield').valid === false
  );
  check(
    'rejects spaces',
    slug.validate('green field').valid === false
  );
  check(
    'rejects underscores',
    slug.validate('green_field').valid === false
  );
  check(
    'accepts numbers',
    slug.validate('school123').valid === true
  );

  // ─── isReserved (requires DB) ──────────────────────────────────────────
  console.log('\n› isReserved (database)');
  check(
    '"app" is reserved',
    (await slug.isReserved('app')) === true
  );
  check(
    '"api" is reserved',
    (await slug.isReserved('api')) === true
  );
  check(
    '"klassrun" is reserved',
    (await slug.isReserved('klassrun')) === true
  );
  check(
    '"greenfield-academy" is NOT reserved',
    (await slug.isReserved('greenfield-academy')) === false
  );

  // ─── isAvailable (requires DB) ─────────────────────────────────────────
  console.log('\n› isAvailable (database)');
  const availResult = await slug.isAvailable('greenfield-academy');
  check(
    '"greenfield-academy" is available',
    availResult.available === true,
    `got error: ${availResult.error}`
  );

  const reservedResult = await slug.isAvailable('app');
  check(
    '"app" is unavailable (reserved)',
    reservedResult.available === false && reservedResult.error.includes('reserved')
  );

  const invalidResult = await slug.isAvailable('ab');
  check(
    '"ab" is unavailable (too short)',
    invalidResult.available === false && invalidResult.error.includes('characters')
  );

  // ─── suggest (requires DB) ─────────────────────────────────────────────
  console.log('\n› suggest (database)');
  const suggestions = await slug.suggest('Greenfield Academy');
  check(
    'returns at least 1 suggestion for new school',
    suggestions.length >= 1,
    `got: ${JSON.stringify(suggestions)}`
  );
  check(
    'first suggestion is the clean base slug',
    suggestions[0] === 'greenfield-academy',
    `got: "${suggestions[0]}"`
  );

  const reservedSuggestions = await slug.suggest('App');
  check(
    'returns suggestions when name produces a reserved slug',
    reservedSuggestions.length === 0 || reservedSuggestions[0] !== 'app',
    `got: ${JSON.stringify(reservedSuggestions)}`
  );

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\n✗ Test run failed:', err);
  process.exit(1);
});
