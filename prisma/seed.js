// prisma/seed.js
// Seeds the ReservedSlug table with system-critical names that schools
// must not be allowed to claim as their subdomain.
//
// Run with: npm run db:seed
// Idempotent — safe to run multiple times.

require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg(process.env.DATABASE_URL);
const prisma = new PrismaClient({ adapter });

// Categories of reserved slugs — keep this list explicit so future devs
// understand WHY each is reserved.
const RESERVED_SLUGS = [
  // Klassrun system subdomains
  { slug: 'app',     reason: 'Klassrun app shell (app.klassrun.com)' },
  { slug: 'api',     reason: 'Klassrun API (api.klassrun.com)' },
  { slug: 'www',     reason: 'Marketing site canonical' },
  { slug: 'admin',   reason: 'Reserved for super-admin tooling' },
  { slug: 'docs',    reason: 'Future documentation portal' },
  { slug: 'help',    reason: 'Future help center' },
  { slug: 'support', reason: 'Future support portal' },
  { slug: 'status',  reason: 'Future status page' },
  { slug: 'blog',    reason: 'Future blog' },
  { slug: 'cdn',     reason: 'Future asset CDN' },
  { slug: 'static',  reason: 'Future static assets' },
  { slug: 'auth',    reason: 'Reserved for auth flows' },
  { slug: 'login',   reason: 'Reserved for login flows' },
  { slug: 'signup',  reason: 'Reserved for signup flows' },
  { slug: 'mail',    reason: 'Mail subdomain' },
  { slug: 'email',   reason: 'Email subdomain' },
  { slug: 'webhook', reason: 'Webhooks endpoint' },
  { slug: 'webhooks', reason: 'Webhooks endpoint' },

  // Common collisions to avoid
  { slug: 'klassrun', reason: 'Brand name' },
  { slug: 'school',   reason: 'Generic — would confuse routing' },
  { slug: 'schools',  reason: 'Generic — would confuse routing' },
  { slug: 'test',     reason: 'Reserved for testing environments' },
  { slug: 'staging',  reason: 'Reserved for staging environments' },
  { slug: 'dev',      reason: 'Reserved for dev environments' },
  { slug: 'demo',     reason: 'Reserved for demo accounts' },
  { slug: 'preview',  reason: 'Reserved for preview deployments' },

  // Single-character slugs (look broken, also reserve)
  { slug: 'a', reason: 'Too short' },
  { slug: 'b', reason: 'Too short' },
  { slug: 'c', reason: 'Too short' },
];

async function seedReservedSlugs() {
  console.log('› Seeding reserved slugs…');

  let created = 0;
  let skipped = 0;

  for (const entry of RESERVED_SLUGS) {
    const existing = await prisma.reservedSlug.findUnique({
      where: { slug: entry.slug },
    });

    if (existing) {
      skipped += 1;
    } else {
      await prisma.reservedSlug.create({ data: entry });
      created += 1;
    }
  }

  console.log(`✓ Reserved slugs: ${created} created, ${skipped} already present.`);
}

async function main() {
  try {
    await seedReservedSlugs();
    console.log('\n✓ Seed complete.');
  } catch (err) {
    console.error('✗ Seed failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
