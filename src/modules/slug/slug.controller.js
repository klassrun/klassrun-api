// src/modules/slug/slug.controller.js
//
// HTTP controllers for slug operations — used by the school signup form
// to check availability and suggest alternatives in real time.

const slug = require('../../utils/slug');

// ── CHECK AVAILABILITY ──
//
// GET /api/slug/check?slug=greenfield-academy
//
// Response:
//   200 { available: true }
//   200 { available: false, error: "This name is already taken by another school." }
//   400 { error: { message: "slug query parameter is required" } }
//
// Note: returns 200 even when unavailable. The frontend uses the `available`
// flag, not the HTTP status, to render its UI.
const check = async (req, res, next) => {
  try {
    const { slug: candidate } = req.query;

    if (!candidate || typeof candidate !== 'string') {
      return res.status(400).json({
        error: { message: 'slug query parameter is required' },
      });
    }

    const result = await slug.isAvailable(candidate.trim().toLowerCase());

    res.json({
      slug: candidate.trim().toLowerCase(),
      available: result.available,
      error: result.error,
    });
  } catch (err) {
    next(err);
  }
};

// ── SUGGEST FROM NAME ──
//
// GET /api/slug/suggest?name=Greenfield+Academy&state=Lagos
//
// Query params:
//   - name (required): the school name to derive suggestions from
//   - state (optional): used as a tiebreaker suffix (e.g. greenfield-lagos)
//   - limit (optional, default 3, max 10): how many suggestions to return
//
// Response:
//   200 { suggestions: ["greenfield-academy", "greenfield-academy-2", "greenfield-academy-lagos"] }
//   200 { suggestions: [] }   ← if name is unworkable or all candidates taken
//   400 { error: { message: "name query parameter is required" } }
const suggest = async (req, res, next) => {
  try {
    const { name, state } = req.query;
    let { limit } = req.query;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: { message: 'name query parameter is required' },
      });
    }

    limit = parseInt(limit, 10) || 3;
    if (limit < 1) limit = 1;
    if (limit > 10) limit = 10;

    const suggestions = await slug.suggest(name, { limit, state });

    res.json({
      name,
      suggestions,
    });
  } catch (err) {
    next(err);
  }
};

// ── GENERATE FROM NAME (no DB lookup, pure transform) ──
//
// GET /api/slug/generate?name=Greenfield+Academy
//
// Returns a clean slug derived from the name without checking availability.
// Useful for showing the user what their slug would look like as they type
// the school name, before we hit the database.
//
// Response:
//   200 { slug: "greenfield-academy", valid: true }
//   200 { slug: "ab", valid: false, error: "Slug must be at least 3 characters." }
const generate = async (req, res, next) => {
  try {
    const { name } = req.query;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: { message: 'name query parameter is required' },
      });
    }

    const candidate = slug.generateFromName(name);
    const validation = slug.validate(candidate);

    res.json({
      slug: candidate,
      valid: validation.valid,
      error: validation.error,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { check, suggest, generate };
