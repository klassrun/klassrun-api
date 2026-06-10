const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

// perf-3: documented adapter config + pool cap (Neon free tier connection limits)
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 5 });
const prisma = global.prisma || new PrismaClient({ adapter });
if (process.env.NODE_ENV !== 'production') global.prisma = prisma;

module.exports = prisma;
