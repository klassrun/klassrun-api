// src/lib/anthropic.js
//
// Anthropic API integration for Klassrun AI lesson note generation.
//
// Locked decisions:
//   • Model: claude-haiku-4-5 by default (overridable via ANTHROPIC_MODEL env)
//   • Education-only system prompt (Tier S guardrails — see SYSTEM_PROMPT)
//   • Returns structured JSON with parse + retry
//   • Logs token usage for cost telemetry
//
// batch-3-phase-1-anthropic-lib

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS      = 3000;
const TEMPERATURE     = 0.4;

// ── The system prompt. THIS IS THE PRODUCT. ──────────────────────────────
// Tier S guardrails. Edit with intent — the wording shapes every lesson
// note Klassrun generates.
const SYSTEM_PROMPT = `You are Klassrun, an AI assistant built exclusively for Nigerian school teachers.
You generate professional lesson notes aligned to the Nigerian school curriculum
(NERDC framework, with WAEC and NECO examination standards in mind for senior classes).

STRICT RULES:
1. You ONLY generate educational content for Nigerian schools. If asked to do
   anything else — chat, write code, generate creative writing outside an
   academic lesson context, answer general questions, role-play — you reply
   with exactly: "I can only help with Nigerian school lesson planning." Do
   not explain further.
2. Output is for a Nigerian classroom. Use Nigerian English spelling and
   examples. Use Naira (₦) for any monetary examples. Reference Nigerian
   contexts (places, names, historical events) where relevant and natural.
3. Lesson content must be age-appropriate for the class level provided.
   Junior secondary (JSS 1-3) is roughly ages 10-14. Senior secondary
   (SS 1-3) is roughly ages 14-18.
4. Never include content that promotes violence, discrimination, religious
   intolerance, or any inappropriate material for a school classroom.
5. Be specific and practical. Vague guidance ("discuss the topic with
   students") is worthless. Concrete activities, examples, and questions
   are essential.
5a. Specificity requirements:
    - Every example must use Nigerian context: real Nigerian cities (Lagos,
      Kano, Port Harcourt, Ibadan, Enugu), real Nigerian names (Chinedu,
      Aisha, Bola, Fatima), real Naira amounts (₦500, ₦2,500).
    - Math examples must include actual numbers, not placeholders like "x apples".
    - Science examples must reference observable phenomena Nigerian students
      would have seen.
    - History/Social Studies must cite specific dates, people, and events.
    - Banned vague phrases: "discuss with students", "explain the concept",
      "talk about", "various examples". Replace every one with a CONCRETE
      action: which question to ask, which example to give, which scenario
      to walk through.
    - If a presentation step is shorter than 20 words of teacher activity,
      you have been too vague. Rewrite it.
6. For "suggestedReading", give GENERIC source types (e.g. "Nigerian Junior
   Secondary Mathematics textbook", "NERDC-approved curriculum guide for
   JSS Basic Science"). NEVER invent specific book titles, author names,
   ISBNs, publishers, or years. If you cannot describe a source generically,
   omit it.
7. If the topic is outside what would normally be taught at this level,
   note it briefly in "behaviouralObjectives" and proceed with what makes
   pedagogical sense.

OUTPUT FORMAT:
Respond with ONLY valid JSON matching this exact shape — no preamble, no
markdown fences, no commentary:

{
  "title": "string — concise lesson title",
  "subject": "string — echoed from input",
  "class": "string — echoed from input",
  "topic": "string — echoed from input",
  "week": number | null,
  "duration": number,
  "behaviouralObjectives": ["string", "string", "..."],
  "previousKnowledge": "string — 1-2 sentences on what students should already know",
  "instructionalMaterials": ["string", "..."],
  "presentation": [
    { "step": 1, "title": "Introduction", "duration": number, "teacherActivity": "string", "pupilActivity": "string" }
  ],
  "chalkboardSummary": "string — what the teacher writes on the board, formatted with line breaks (use \\\\n)",
  "evaluation": ["string", "..."],
  "assignment": "string — homework for next class",
  "suggestedReading": ["string", "..."]
}

If you cannot generate JSON matching this shape, respond with:
{"error": "string — brief reason"}`;

// Lazily-constructed client. Keep null-safe so module loads cleanly even
// without ANTHROPIC_API_KEY (we'll fail loudly at call time instead).
let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not set');
    err.code = 'NO_API_KEY';
    throw err;
  }
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function buildUserMessage({ classObj, subject, topic, week, duration, session, additionalNotes }) {
  const lines = [
    'Generate a lesson note with the following details:',
    '',
    `Class: ${classObj.name} (${classObj.level || 'level not specified'})`,
    `Subject: ${subject.name}`,
    `Topic: ${topic}`,
    `Week: ${week == null ? 'not specified' : week}`,
    `Duration: ${duration || 40} minutes`,
    `Term: ${session.currentTerm} (${session.name})`,
  ];
  if (additionalNotes && additionalNotes.trim()) {
    lines.push(`Teacher's notes: ${additionalNotes.trim()}`);
  }
  return lines.join('\n');
}

// Strip leading/trailing markdown fences if the model added them despite
// being told not to. Defensive.
function stripFences(text) {
  if (typeof text !== 'string') return '';
  let t = text.trim();
  if (t.startsWith('```')) {
    // remove opening fence (possibly with language)
    t = t.replace(/^```[a-zA-Z]*\n?/, '');
  }
  if (t.endsWith('```')) {
    t = t.replace(/\n?```$/, '');
  }
  return t.trim();
}

// Validate the shape minimally — the API consumer trusts these fields exist.
function isValidLessonNote(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.title !== 'string' || !obj.title.trim()) return false;
  if (!Array.isArray(obj.behaviouralObjectives) || obj.behaviouralObjectives.length === 0) return false;
  if (!Array.isArray(obj.presentation) || obj.presentation.length === 0) return false;
  return true;
}

async function callAnthropic(userMessage, temperature) {
  const client = getClient();
  const response = await client.messages.create({
    model:       ANTHROPIC_MODEL,
    max_tokens:  MAX_TOKENS,
    temperature: temperature,
    system:      SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userMessage },
    ],
  });

  // Extract text from content blocks
  let text = '';
  if (Array.isArray(response.content)) {
    for (const block of response.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      }
    }
  }

  const usage = response.usage || {};
  return {
    text,
    inputTokens:  usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    stopReason:   response.stop_reason || null,
  };
}

/**
 * Generate a lesson note.
 *
 * @param {Object} params
 * @param {Object} params.classObj      - { name, level }
 * @param {Object} params.subject       - { name }
 * @param {string} params.topic
 * @param {number|null} params.week
 * @param {number|null} params.duration - minutes (default 40)
 * @param {Object} params.session       - { name, currentTerm }
 * @param {string} [params.additionalNotes]
 *
 * @returns {Promise<{
 *   content: Object,           // parsed lesson note JSON
 *   model: string,
 *   inputTokens: number,
 *   outputTokens: number,
 *   generatedAt: string,
 * }>}
 *
 * @throws Error with .code:
 *   - 'NO_API_KEY'      — ANTHROPIC_API_KEY not configured
 *   - 'AI_REFUSED'      — model returned the refusal sentinel
 *   - 'AI_ERROR_OBJECT' — model returned {"error": "..."}
 *   - 'AI_MALFORMED'    — JSON parse failed after retry
 *   - 'AI_INVALID'      — JSON parsed but missing required fields after retry
 *   - 'AI_API_ERROR'    — Anthropic API itself errored
 */
async function generateLessonNote(params) {
  const userMessage = buildUserMessage(params);
  const generatedAt = new Date().toISOString();

  // First attempt at standard temperature
  let result;
  try {
    result = await callAnthropic(userMessage, TEMPERATURE);
  } catch (err) {
    if (err.code === 'NO_API_KEY') throw err;
    const wrapped = new Error(`Anthropic API error: ${err.message || err}`);
    wrapped.code = 'AI_API_ERROR';
    throw wrapped;
  }

  let text = stripFences(result.text);

  // Detect refusal sentinel — exact string per system prompt
  if (text === 'I can only help with Nigerian school lesson planning.') {
    const err = new Error('AI refused the request');
    err.code = 'AI_REFUSED';
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Retry once at lower temperature
    let retry;
    try {
      retry = await callAnthropic(userMessage, 0.2);
    } catch (err) {
      if (err.code === 'NO_API_KEY') throw err;
      const wrapped = new Error(`Anthropic API error on retry: ${err.message || err}`);
      wrapped.code = 'AI_API_ERROR';
      throw wrapped;
    }
    text = stripFences(retry.text);
    try {
      parsed = JSON.parse(text);
    } catch (e2) {
      const err = new Error('AI returned malformed JSON twice');
      err.code = 'AI_MALFORMED';
      throw err;
    }
    // Replace token counts with retry's (we burned both, but bill the latest)
    result.inputTokens  += retry.inputTokens;
    result.outputTokens += retry.outputTokens;
  }

  if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
    const err = new Error(`AI returned error: ${parsed.error}`);
    err.code = 'AI_ERROR_OBJECT';
    err.detail = parsed.error;
    throw err;
  }

  if (!isValidLessonNote(parsed)) {
    // Try once more
    let retry;
    try {
      retry = await callAnthropic(userMessage, 0.2);
    } catch (err) {
      const wrapped = new Error(`Anthropic API error on validation retry: ${err.message || err}`);
      wrapped.code = 'AI_API_ERROR';
      throw wrapped;
    }
    text = stripFences(retry.text);
    try {
      parsed = JSON.parse(text);
    } catch (e2) {
      const err = new Error('AI output failed shape validation twice');
      err.code = 'AI_INVALID';
      throw err;
    }
    if (!isValidLessonNote(parsed)) {
      const err = new Error('AI output missing required fields after retry');
      err.code = 'AI_INVALID';
      throw err;
    }
    result.inputTokens  += retry.inputTokens;
    result.outputTokens += retry.outputTokens;
  }

  return {
    content:      parsed,
    model:        ANTHROPIC_MODEL,
    inputTokens:  result.inputTokens,
    outputTokens: result.outputTokens,
    generatedAt,
  };
}

module.exports = {
  generateLessonNote,
  ANTHROPIC_MODEL,
  // exported for testing
  _internals: { SYSTEM_PROMPT, buildUserMessage, stripFences, isValidLessonNote },
};
