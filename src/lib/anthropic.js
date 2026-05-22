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
const MAX_TOKENS      = 6000; // hotfix-batch-3-phase-1-5-max-tokens (was 3000, truncated Mathematics + LaTeX notes)
const TEMPERATURE     = 0.4;

// batch-3-phase-1-5-prompt-v2
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
    - If a presentation step is shorter than 12 words of teacher activity,
      you have been too vague. Rewrite it.
6. For "suggestedReading", give GENERIC source types (e.g. "Nigerian Junior
   Secondary Mathematics textbook", "NERDC-approved curriculum guide for
   JSS Basic Science"). NEVER invent specific book titles, author names,
   ISBNs, publishers, or years. If you cannot describe a source generically,
   omit it.
7. If the topic is outside what would normally be taught at this level,
   note it briefly in "behaviouralObjectives" and proceed with what makes
   pedagogical sense.

8. MATHEMATICAL NOTATION:
   Whenever your output contains math — fractions, exponents, roots, equations,
   summations, integrals, matrices, anything that would not read cleanly as
   plain text — you MUST express it in LaTeX inside delimiters.
     - Use $...$ for inline math within a sentence.
       Example: "The fraction $\\\\frac{1}{2}$ is read as one-half."
     - Use $$...$$ for block math on its own line.
       Example: "$$x = \\\\frac{-b \\\\pm \\\\sqrt{b^2 - 4ac}}{2a}$$"
   Plain-text math is BANNED. NEVER write "1/2", "x^2", "sqrt(16)", "3 * 4",
   "a/b", "2^3", or similar. ALWAYS write "$\\\\frac{1}{2}$", "$x^{2}$",
   "$\\\\sqrt{16}$", "$3 \\\\times 4$", "$\\\\frac{a}{b}$", "$2^{3}$".
   This rule applies to EVERY field — title, behaviouralObjectives,
   previousKnowledge, presentation steps, explanationOverview,
   explanationSections.content, chalkboardSummary, evaluation, assignment,
   suggestedReading.
   Do NOT use $ for anything other than math. (Naira amounts always use ₦,
   never $.)
   When in doubt, prefer LaTeX. A math-teacher reader will be using this in
   front of students.

9. SUB-TOPICS:
   The teacher may provide a "subTopics" list in the request.
     - If subTopics is provided and non-empty: you MUST produce
       "explanationSections" with EXACTLY one entry per sub-topic, in the
       SAME ORDER as provided, using each sub-topic verbatim as the
       "subTopic" field. Do NOT add new sub-topics. Do NOT skip any. Do NOT
       merge or split them. Do NOT rephrase the sub-topic text.
     - If subTopics is empty or absent: you MUST CHOOSE 2 to 4 pedagogically
       sensible sub-topics yourself, label them in "subTopic", and produce
       content for each.
   Each "content" field must be at least 3 sentences of teaching-grade
   explanation a teacher can dictate or paraphrase in class. Use math
   delimiters per rule 8 wherever appropriate.

10. EXPLANATION OVERVIEW:
    "explanationOverview" must always be 1 to 2 sentences that frame the
    whole topic before the sub-topics. It comes BEFORE "explanationSections"
    structurally. It exists whether or not sub-topics were provided.

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
  "explanationOverview": "string — 1-2 sentences framing the topic",
  "explanationSections": [
    { "subTopic": "string", "content": "string with LaTeX where appropriate" }
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

function buildUserMessage({ classObj, subject, topic, week, duration, session, additionalNotes, subTopics }) {
  // batch-3-phase-1-5-subtopics-builder
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
  if (Array.isArray(subTopics) && subTopics.length > 0) {
    lines.push('');
    lines.push('Sub-topics (use EXACTLY these as section headers in this order):');
    subTopics.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  if (additionalNotes && additionalNotes.trim()) {
    lines.push('');
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
  // batch-3-phase-1-5-shape: explanationSections is required (AI must produce it,
  // either echoing teacher's subTopics or picking its own 2-4).
  if (!Array.isArray(obj.explanationSections) || obj.explanationSections.length === 0) return false;
  for (const sec of obj.explanationSections) {
    if (!sec || typeof sec !== 'object') return false;
    if (typeof sec.subTopic !== 'string' || !sec.subTopic.trim()) return false;
    if (typeof sec.content !== 'string' || !sec.content.trim()) return false;
  }
  if (typeof obj.explanationOverview !== 'string') return false;
  return true;
}

// hotfix-batch-3-phase-1-5-cost-control
// Classify an Anthropic SDK error into our internal error codes.
// Anthropic SDK errors have .status (HTTP status from the API).
function classifyAnthropicError(err) {
  const status = err && err.status;
  if (status === 429 || status === 529) {
    const wrapped = new Error('Anthropic transient error (' + status + '): ' + (err.message || 'unknown'));
    wrapped.code = 'AI_TRANSIENT';
    wrapped.status = status;
    return wrapped;
  }
  if (status === 400 || status === 401 || status === 403) {
    const wrapped = new Error('Anthropic permanent error (' + status + '): ' + (err.message || 'unknown'));
    wrapped.code = 'AI_PERMANENT';
    wrapped.status = status;
    return wrapped;
  }
  const wrapped = new Error('Anthropic API error: ' + (err.message || err));
  wrapped.code = 'AI_API_ERROR';
  wrapped.status = status;
  return wrapped;
}

async function callAnthropic(userMessage, temperature) {
  // hotfix-batch-3-phase-1-5-diagnostic-logs
  const client = getClient();
  let response;
  try {
    response = await client.messages.create({
    model:       ANTHROPIC_MODEL,
    max_tokens:  MAX_TOKENS,
    temperature: temperature,
    system:      SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
      ],
    });
  } catch (err) {
    // hotfix-batch-3-phase-1-5-diagnostic-logs
    console.error('[callAnthropic] Anthropic SDK error:', {
      name:       err && err.name,
      status:     err && err.status,
      type:       err && err.type,
      code:       err && err.code,
      message:    err && err.message,
      requestId:  err && (err.request_id || (err.headers && err.headers['request-id'])),
      errorBody:  err && err.error,
    });
    throw err;
  }

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
    // hotfix-batch-3-phase-1-5-cost-control
    if (err.code === 'NO_API_KEY') throw err;
    throw classifyAnthropicError(err);
  }

  let text = stripFences(result.text);
  // hotfix-batch-3-phase-1-5-diagnostic-logs
  console.error('[generateLessonNote] first response:', {
    stopReason:    result.stopReason,
    inputTokens:   result.inputTokens,
    outputTokens:  result.outputTokens,
    textLength:    text.length,
    textPreview:   text.length > 500 ? text.slice(0, 250) + ' ... ' + text.slice(-250) : text,
  });

  // Detect refusal sentinel — exact string per system prompt
  if (text === 'I can only help with Nigerian school lesson planning.') {
    const err = new Error('AI refused the request');
    err.code = 'AI_REFUSED';
    throw err;
  }

  // hotfix-batch-3-phase-1-5-max-tokens
  // Detect truncation BEFORE JSON.parse. Parsing truncated JSON fails;
  // the retry hits the same cap and wastes another full generation.
  if (result.stopReason === 'max_tokens') {
    console.error('[generateLessonNote] truncated at max_tokens:', {
      outputTokens: result.outputTokens,
      textLength:   text.length,
    });
    const err = new Error('AI output truncated at max_tokens (' + result.outputTokens + ' tokens)');
    err.code = 'AI_TRUNCATED';
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
      // hotfix-batch-3-phase-1-5-cost-control
      if (err.code === 'NO_API_KEY') throw err;
      throw classifyAnthropicError(err);
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

  // hotfix-batch-3-phase-1-5-cost-control
  // No retry on validation failure — same prompt, same model, same shape;
  // retrying usually fails again. Throw immediately, save the tokens.
  if (!isValidLessonNote(parsed)) {
    console.error('[generateLessonNote] AI_INVALID (no retry):', {
      hasTitle:                 typeof parsed?.title === 'string' && !!parsed.title.trim(),
      hasBehaviouralObjectives: Array.isArray(parsed?.behaviouralObjectives) && parsed.behaviouralObjectives.length > 0,
      hasPresentation:          Array.isArray(parsed?.presentation) && parsed.presentation.length > 0,
      hasExplanationSections:   Array.isArray(parsed?.explanationSections) && parsed.explanationSections.length > 0,
      hasExplanationOverview:   typeof parsed?.explanationOverview === 'string',
      topLevelKeys:             parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
    });
    const err = new Error('AI output missing required fields');
    err.code = 'AI_INVALID';
    throw err;
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
