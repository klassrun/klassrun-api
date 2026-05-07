// src/utils/slug.js
// Slug utilities for school subdomains.
//
// A slug maps a school to its subdomain:
//   "Greenfield Academy" → "greenfield-academy" → greenfield-academy.klassrun.com
//
// Rules:
//   - 3 to 40 characters
//   - Lowercase letters, digits, and hyphens only
//   - Cannot start or end with a hyphen
//   - Cannot contain consecutive hyphens
//   - Cannot match anything in the ReservedSlug table
//   - Must be unique across all schools

const prisma = require('../config/db');

// ─── Constants ────────────────────────────────────────────────────────────

const MIN_LENGTH = 3;
const MAX_LENGTH = 40;
const VALID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ─── generateFromName ─────────────────────────────────────────────────────

/**
 * Convert a school name into a clean slug candidate.
 *
 * Examples:
 *   "Greenfield Academy"       → "greenfield-academy"
 *   "Kings' College, Lagos"    → "kings-college-lagos"
 *   "ABC International School" → "abc-international-school"
 *   "  Multiple   Spaces  "    → "multiple-spaces"
 *
 * The output is NOT guaranteed to be valid or available — call validate()
 * and isAvailable() to check.
 */
function generateFromName(name) {
  if (typeof name !== 'string') return '';

  return name
    .toLowerCase()
    .normalize('NFD')                  // strip accents (e.g. "café" → "cafe")
    .replace(/[\u0300-\u036f]/g, '')   // remove combining marks
    .replace(/[^a-z0-9]+/g, '-')       // non-alphanumerics → hyphens
    .replace(/^-+|-+$/g, '')           // trim leading/trailing hyphens
    .replace(/-+/g, '-')               // collapse consecutive hyphens
    .slice(0, MAX_LENGTH)              // cap length
    .replace(/-+$/, '');               // re-trim if slice left a trailing hyphen
}

// ─── validate ─────────────────────────────────────────────────────────────

/**
 * Validate slug format. Returns { valid: boolean, error: string | null }.
 *
 * Use this for user-facing form validation BEFORE hitting the database.
 */
function validate(slug) {
  if (typeof slug !== 'string') {
    return { valid: false, error: 'Slug must be a string.' };
  }

  if (slug.length < MIN_LENGTH) {
    return { valid: false, error: `Slug must be at least ${MIN_LENGTH} characters.` };
  }

  if (slug.length > MAX_LENGTH) {
    return { valid: false, error: `Slug must be ${MAX_LENGTH} characters or fewer.` };
  }

  if (!VALID_PATTERN.test(slug)) {
    return {
      valid: false,
      error: 'Slug can only contain lowercase letters, numbers, and hyphens — no leading, trailing, or consecutive hyphens.',
    };
  }

  return { valid: true, error: null };
}

// ─── isReserved ───────────────────────────────────────────────────────────

/**
 * Returns true if the slug is in the ReservedSlug table (e.g. "app", "api").
 * Returns false otherwise.
 */
async function isReserved(slug) {
  if (!slug) return false;

  const reserved = await prisma.reservedSlug.findUnique({
    where: { slug },
  });

  return reserved !== null;
}

// ─── isTaken ──────────────────────────────────────────────────────────────

/**
 * Returns true if a school already owns this slug.
 */
async function isTaken(slug) {
  if (!slug) return false;

  const school = await prisma.school.findUnique({
    where: { slug },
    select: { id: true },
  });

  return school !== null;
}

// ─── isAvailable ──────────────────────────────────────────────────────────

/**
 * Comprehensive availability check — combines validate, isReserved, isTaken.
 *
 * Returns { available: boolean, error: string | null }.
 *
 * Use this on the signup endpoint before creating a school. Use this
 * (debounced) on the signup form for live availability feedback.
 */
async function isAvailable(slug) {
  const validation = validate(slug);
  if (!validation.valid) {
    return { available: false, error: validation.error };
  }

  if (await isReserved(slug)) {
    return { available: false, error: 'This name is reserved by Klassrun and cannot be used.' };
  }

  if (await isTaken(slug)) {
    return { available: false, error: 'This name is already taken by another school.' };
  }

  return { available: true, error: null };
}

// ─── suggest ──────────────────────────────────────────────────────────────

/**
 * Generate up to N available slug suggestions from a school name.
 *
 * Tries in this order:
 *   1. The clean slug from the name
 *   2. clean-slug-2, clean-slug-3, ... up to clean-slug-9
 *   3. clean-slug-{state} if a state is provided
 *
 * Returns an array of available slugs (may be empty if name is unworkable).
 */
async function suggest(name, options = {}) {
  const { limit = 3, state = null } = options;
  const base = generateFromName(name);

  if (!base || base.length < MIN_LENGTH) {
    return [];
  }

  const candidates = [base];

  // Numeric suffixes
  for (let i = 2; i <= 9; i++) {
    candidates.push(`${base}-${i}`);
  }

  // Geographic suffix if provided (e.g. "kings-college-lagos")
  if (state && typeof state === 'string') {
    const stateSlug = generateFromName(state);
    if (stateSlug) {
      candidates.push(`${base}-${stateSlug}`);
    }
  }

  const results = [];
  for (const candidate of candidates) {
    if (results.length >= limit) break;

    const truncated = candidate.slice(0, MAX_LENGTH).replace(/-+$/, '');
    const check = await isAvailable(truncated);

    if (check.available) {
      results.push(truncated);
    }
  }

  return results;
}

// ─── Exports ──────────────────────────────────────────────────────────────


// ─── buildPortalUrl ───────────────────────────────────────────────────────

/**
 * Construct the URL where a school's dashboard lives.
 *
 * Currently returns the shared dashboard URL (Path A — single subdomain
 * for all schools). When per-school subdomains are activated later, this
 * will return https://<slug>.klassrun.com/dashboard.
 */
function buildPortalUrl(slug) {
  const baseDomain = process.env.PORTAL_BASE_DOMAIN || 'klassrun.com';
  const frontendUrl = process.env.FRONTEND_URL || `https://app.${baseDomain}`;
  return `${frontendUrl}/dashboard`;
}

module.exports = {
  generateFromName,
  validate,
  isReserved,
  isTaken,
  isAvailable,
  suggest,
  buildPortalUrl,
  // exported constants for tests and form validation
  MIN_LENGTH,
  MAX_LENGTH,
  VALID_PATTERN,
};
