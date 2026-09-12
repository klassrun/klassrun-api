// src/lib/cogs-log.js
// genobs-v1
//
// One log line per AI generation, carrying the real token counts and the
// naira they cost. No database, no schema, no request-path effect.
//
// Why this exists: tokens were already captured per generation and thrown
// into jsonb _metadata, where nothing reads them. Measuring cost meant
// running a harness against the live SDK. This makes every generation
// self-reporting, from the first school onward.
//
// Rates are env-tunable so an FX move or a model-price change does not
// need a deploy:
//   COGS_FX_NGN_PER_USD     default 1550
//   COGS_USD_PER_MTOK_IN    default 1     (Haiku 4.5 input,  $/million)
//   COGS_USD_PER_MTOK_OUT   default 5     (Haiku 4.5 output, $/million)
//
// Grep the logs:  [COGS]
// Roll up a month:  filter by school=<schoolId>, sum the ngn= field.
//
// This module must never affect a response. Every path is wrapped.

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const FX       = num(process.env.COGS_FX_NGN_PER_USD, 1550);
const IN_RATE  = num(process.env.COGS_USD_PER_MTOK_IN, 1);
const OUT_RATE = num(process.env.COGS_USD_PER_MTOK_OUT, 5);

/**
 * Log the cost of one AI generation. Fire-and-forget, never throws.
 *
 * @param {object} o
 * @param {string} o.schoolId      tenant the spend belongs to
 * @param {string} o.kind          'lesson-note' | 'scheme' | 'exam-questions' | ...
 * @param {string} [o.model]       model string as reported by the SDK
 * @param {number} [o.inputTokens]
 * @param {number} [o.outputTokens]
 */
function logGenerationCost(o) {
  try {
    const opts = o || {};
    const hasIn  = Number.isFinite(Number(opts.inputTokens));
    const hasOut = Number.isFinite(Number(opts.outputTokens));
    const inTok  = hasIn  ? Number(opts.inputTokens)  : 0;
    const outTok = hasOut ? Number(opts.outputTokens) : 0;

    const usd = (inTok / 1e6) * IN_RATE + (outTok / 1e6) * OUT_RATE;
    const ngn = usd * FX;

    console.log(
      '[COGS] kind=%s school=%s model=%s in=%d out=%d ngn=%s%s',
      opts.kind || 'unknown',
      opts.schoolId || 'none',
      opts.model || 'unknown',
      inTok,
      outTok,
      ngn.toFixed(2),
      (hasIn || hasOut) ? '' : ' tokens=MISSING'
    );
  } catch (_e) {
    // Observability must never break a generation.
  }
}

module.exports = {
  logGenerationCost,
  _internal: { FX, IN_RATE, OUT_RATE },
};
