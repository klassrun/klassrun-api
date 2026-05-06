// scripts/seed-super-admin.js
//
// Creates or updates a SUPER_ADMIN user from environment variables.
// SUPER_ADMIN users have schoolId = null and have access to platform-wide
// admin tooling (the future /admin route group).
//
// Run with:  npm run db:seed:super-admin
// Idempotent — safe to run multiple times. Updates the password if it has
// changed in ENV; otherwise no-op.
//
// REQUIRED ENV VARS:
//   SUPER_ADMIN_EMAIL       The super admin's email address
//   SUPER_ADMIN_PASSWORD    Their password (min 12 chars recommended)
//   SUPER_ADMIN_FIRST_NAME  Display name
//   SUPER_ADMIN_LAST_NAME   Display name
//
// SECURITY:
//   - Password must be at least 8 characters; we recommend 16+ random.
//   - Never commit .env. The values live only in .env locally and Railway's
//     environment variables in production.

require('dotenv/config');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg(process.env.DATABASE_URL);
const prisma  = new PrismaClient({ adapter });

async function main() {
  const email     = process.env.SUPER_ADMIN_EMAIL;
  const password  = process.env.SUPER_ADMIN_PASSWORD;
  const firstName = process.env.SUPER_ADMIN_FIRST_NAME;
  const lastName  = process.env.SUPER_ADMIN_LAST_NAME;

  if (!email || !password || !firstName || !lastName) {
    console.error('✗ Missing SUPER_ADMIN_* environment variables.');
    console.error('  Required: SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, SUPER_ADMIN_FIRST_NAME, SUPER_ADMIN_LAST_NAME');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('✗ SUPER_ADMIN_PASSWORD must be at least 8 characters. Use a password manager — 16+ random recommended.');
    process.exit(1);
  }

  console.log('› Seeding SUPER_ADMIN…');

  const hashedPassword = await bcrypt.hash(password, 12);
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    if (existing.role !== 'SUPER_ADMIN') {
      console.error(`✗ User ${email} exists but role is ${existing.role}, not SUPER_ADMIN. Refusing to overwrite.`);
      process.exit(1);
    }

    await prisma.user.update({
      where: { email },
      data: {
        password: hashedPassword,
        firstName,
        lastName,
        isActive: true,
        inviteAccepted: true,
      },
    });
    console.log(`✓ Updated existing SUPER_ADMIN: ${email}`);
  } else {
    await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName,
        lastName,
        role: 'SUPER_ADMIN',
        isActive: true,
        inviteAccepted: true,
        schoolId: null,
      },
    });
    console.log(`✓ Created new SUPER_ADMIN: ${email}`);
  }

  // Audit trail
  try {
    await prisma.authEvent.create({
      data: {
        type: 'SUPER_ADMIN_SEEDED',
        email,
        metadata: { action: existing ? 'updated' : 'created' },
      },
    });
  } catch {
    // AuthEvent table might not exist yet on first run — non-fatal
  }

  console.log('\n✓ Done.');
}

main()
  .catch((err) => {
    console.error('✗ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
