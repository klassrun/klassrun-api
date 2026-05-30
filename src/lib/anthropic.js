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

// batch-3-phase-2-scheme-call-shared
async function _callAnthropicWithSystem(systemPrompt, userMessage, maxTokens, temperature) {
  // hotfix-batch-3-phase-1-5-diagnostic-logs
  const client = getClient();
  let response;
  try {
    response = await client.messages.create({
    model:       ANTHROPIC_MODEL,
    max_tokens:  maxTokens,
    temperature: temperature,
    system:      systemPrompt,
      messages: [
        { role: 'user', content: userMessage },
      ],
    });
  } catch (err) {
    // hotfix-batch-3-phase-1-5-diagnostic-logs
    console.error('[_callAnthropicWithSystem] Anthropic SDK error:', {
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

async function callAnthropic(userMessage, temperature) {
  return _callAnthropicWithSystem(SYSTEM_PROMPT, userMessage, MAX_TOKENS, temperature);
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



// batch-3-phase-2-scheme-generator
// ───────────────────────────────────────────────────────────────────────────
// Scheme of Work generation — Phase 3.2.
//
// Reuses _callAnthropicWithSystem, ANTHROPIC_MODEL, stripFences, getClient,
// and classifyAnthropicError from the lesson-note pipeline above.
// ───────────────────────────────────────────────────────────────────────────

const SCHEME_MAX_TOKENS = 10000;

// batch-3-phase-2-scheme-prompt
const SCHEME_SYSTEM_PROMPT = `You are Klassrun, an AI assistant built exclusively for Nigerian school teachers.
You generate professional 12-week schemes of work aligned to the Nigerian
school curriculum (NERDC framework, with WAEC and NECO standards for senior classes).

STRICT RULES:
1. You ONLY generate schemes of work for Nigerian schools. If asked to do
   anything else — chat, write code, generate creative writing outside an
   academic context, answer general questions, role-play — you reply with
   exactly: "I can only help with Nigerian school lesson planning." Do not
   explain further.
2. Output is for a Nigerian classroom. Use Nigerian English spelling and
   examples. Use Naira (₦) for any monetary examples. Reference Nigerian
   contexts where relevant.
3. Content must be age-appropriate for the class level provided.
   Junior secondary (JSS 1-3) is roughly ages 10-14. Senior secondary
   (SS 1-3) is roughly ages 14-18.
4. Never include content promoting violence, discrimination, religious
   intolerance, or anything inappropriate for a school classroom.
5. Be concrete. Vague entries like "introduction to the topic" are useless.
   Each week's topic must be a specific concept, not a category. Each
   activity must be a concrete classroom action a teacher can read and execute.
6. SCHEME STRUCTURE:
   - Exactly 12 weeks unless the teacher specifies a different count
     in the request (1-13 weeks allowed).
   - Each week's topic must build on the previous one — a logical learning
     progression, not a random list.
   - Distribute pedagogically: foundational concepts early, applications
     and revision later. Reserve at least one week near the end for
     revision or assessment preparation.
7. OBJECTIVES MUST BEGIN WITH A VERB:
   Every objective must begin with an action verb suitable for measurable
   learning outcomes: define, identify, calculate, solve, describe, list,
   compare, explain, draw, construct, apply, classify, analyse, evaluate.
   Do NOT begin objectives with "Students will" or "To understand".
8. TOPIC STRICTNESS:
   The teacher may provide a "topics" list in the request.
     - If topics is provided and non-empty: you MUST produce exactly one
       week per topic in the SAME ORDER, using each topic verbatim as the
       week's "topic" field. Do NOT add weeks. Do NOT skip topics. Do NOT
       merge, split, or rephrase topic text.
     - If topics is empty or absent: choose 12 weekly topics yourself in
       pedagogical order.
9. MATHEMATICAL NOTATION:
   Whenever your output contains math, express it in LaTeX inside \$...\$
   (inline) or \$\$...\$\$ (block) delimiters. Plain-text math like "1/2",
   "x^2", or "sqrt(16)" is BANNED. Always use \$\\frac{1}{2}\$, \$x^{2}\$,
   \$\\sqrt{16}\$, etc. Apply across all fields. Use ₦ for Naira, never \$.
10. AVOID INVENTED SOURCES:
    For "resources", use GENERIC source types ("NERDC-approved JSS
    Mathematics textbook", "school laboratory equipment", "newspaper
    articles on Nigerian current affairs"). NEVER invent specific book
    titles, author names, ISBNs, publishers, or years.

OUTPUT FORMAT:
Respond with ONLY valid JSON matching this exact shape — no preamble, no
markdown fences, no commentary:

{
  "title": "string — concise scheme title, e.g. 'JSS 2 Mathematics — Term 2 Scheme of Work'",
  "subject": "string — echoed from input",
  "class": "string — echoed from input",
  "term": "string — echoed from input (FIRST/SECOND/THIRD)",
  "sessionName": "string — echoed from input",
  "overview": "string — 2-3 sentences framing what students will learn this term",
  "weeks": [
    {
      "weekNumber": 1,
      "topic": "string — specific concept, not a category",
      "objectives": ["string", "string"],
      "activities": ["string", "string", "string"],
      "assessment": "string — one sentence on how the week's learning is checked",
      "resources": ["string"]
    }
  ]
}

If you cannot generate JSON matching this shape, respond with:
{"error": "string — brief reason"}`;

// batch-3-phase-2-scheme-builder
function buildSchemeUserMessage({ classObj, subject, session, weekCount, topics, additionalNotes }) {
  const lines = [
    'Generate a scheme of work with the following details:',
    '',
    `Class: ${classObj.name} (${classObj.level || 'level not specified'})`,
    `Subject: ${subject.name}`,
    `Term: ${session.currentTerm} (${session.name})`,
    `Weeks: ${weekCount || 12}`,
  ];
  if (Array.isArray(topics) && topics.length > 0) {
    lines.push('');
    lines.push('Weekly topics (use EXACTLY these in this order, one per week):');
    topics.forEach((t, i) => lines.push(`  Week ${i + 1}: ${t}`));
  }
  if (additionalNotes && additionalNotes.trim()) {
    lines.push('');
    lines.push(`Teacher's notes: ${additionalNotes.trim()}`);
  }
  return lines.join('\n');
}

// batch-3-phase-2-scheme-validator
function isValidSchemeOfWork(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.title !== 'string' || !obj.title.trim()) return false;
  if (typeof obj.overview !== 'string') return false;
  if (!Array.isArray(obj.weeks) || obj.weeks.length === 0) return false;
  if (obj.weeks.length > 13) return false;
  for (const w of obj.weeks) {
    if (!w || typeof w !== 'object') return false;
    if (!Number.isInteger(w.weekNumber) || w.weekNumber < 1 || w.weekNumber > 13) return false;
    if (typeof w.topic !== 'string' || !w.topic.trim()) return false;
    if (!Array.isArray(w.objectives) || w.objectives.length === 0) return false;
    if (!Array.isArray(w.activities) || w.activities.length === 0) return false;
    if (typeof w.assessment !== 'string' || !w.assessment.trim()) return false;
    if (w.resources !== undefined && !Array.isArray(w.resources)) return false;
  }
  return true;
}

/**
 * Generate a 12-week scheme of work.
 *
 * Throws the same error-code surface as generateLessonNote:
 *   NO_API_KEY · AI_REFUSED · AI_ERROR_OBJECT · AI_TRUNCATED
 *   AI_TRANSIENT · AI_PERMANENT · AI_API_ERROR · AI_MALFORMED · AI_INVALID
 */
async function generateSchemeOfWork(params) {
  const userMessage = buildSchemeUserMessage(params);
  const generatedAt = new Date().toISOString();

  let result;
  try {
    result = await _callAnthropicWithSystem(SCHEME_SYSTEM_PROMPT, userMessage, SCHEME_MAX_TOKENS, TEMPERATURE);
  } catch (err) {
    if (err.code === 'NO_API_KEY') throw err;
    throw classifyAnthropicError(err);
  }

  let text = stripFences(result.text);
  console.error('[generateSchemeOfWork] first response:', {
    stopReason:   result.stopReason,
    inputTokens:  result.inputTokens,
    outputTokens: result.outputTokens,
    textLength:   text.length,
    textPreview:  text.length > 500 ? text.slice(0, 250) + ' ... ' + text.slice(-250) : text,
  });

  if (text === 'I can only help with Nigerian school lesson planning.') {
    const err = new Error('AI refused the request');
    err.code = 'AI_REFUSED';
    throw err;
  }

  if (result.stopReason === 'max_tokens') {
    console.error('[generateSchemeOfWork] truncated at max_tokens:', {
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
    let retry;
    try {
      retry = await _callAnthropicWithSystem(SCHEME_SYSTEM_PROMPT, userMessage, SCHEME_MAX_TOKENS, 0.2);
    } catch (err) {
      if (err.code === 'NO_API_KEY') throw err;
      throw classifyAnthropicError(err);
    }
    text = stripFences(retry.text);
    if (retry.stopReason === 'max_tokens') {
      const err = new Error('AI output truncated on retry');
      err.code = 'AI_TRUNCATED';
      throw err;
    }
    try {
      parsed = JSON.parse(text);
    } catch (e2) {
      const err = new Error('AI returned malformed JSON twice');
      err.code = 'AI_MALFORMED';
      throw err;
    }
    result.inputTokens  += retry.inputTokens;
    result.outputTokens += retry.outputTokens;
  }

  if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
    const err = new Error(`AI returned error: ${parsed.error}`);
    err.code = 'AI_ERROR_OBJECT';
    err.detail = parsed.error;
    throw err;
  }

  if (!isValidSchemeOfWork(parsed)) {
    console.error('[generateSchemeOfWork] AI_INVALID (no retry):', {
      hasTitle:    typeof parsed?.title === 'string' && !!parsed.title.trim(),
      hasOverview: typeof parsed?.overview === 'string',
      hasWeeks:    Array.isArray(parsed?.weeks),
      weeksLength: Array.isArray(parsed?.weeks) ? parsed.weeks.length : null,
      topLevelKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
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


// batch-3-phase-3a-question-generator
// ───────────────────────────────────────────────────────────────────────────
// Exam Question generation — Phase 3.3a.
// Reuses _callAnthropicWithSystem, ANTHROPIC_MODEL, stripFences, classifyAnthropicError.
// Questions saved with UUID fingerprint (dedup in Phase 3.3b).
// ───────────────────────────────────────────────────────────────────────────

const QUESTION_MAX_TOKENS = 8000;

// batch-3-phase-3a-question-prompt
const QUESTION_SYSTEM_PROMPT = `You are Klassrun, an AI assistant built exclusively for Nigerian school teachers.
You generate professional exam questions aligned to the Nigerian school curriculum
(NERDC framework, WAEC and NECO examination standards for senior classes,
BECE standards for junior classes).

STRICT RULES:
1. You ONLY generate exam questions for Nigerian schools. If asked to do
   anything else — chat, write code, generate creative writing outside an
   academic context, answer general questions, role-play — you reply with
   exactly: "I can only help with Nigerian school lesson planning." Do not
   explain further.
2. Output is for a Nigerian classroom. Use Nigerian English spelling and
   examples. Use Naira (₦) for monetary examples. Reference Nigerian
   contexts (places, names, historical events) where relevant and natural.
3. Questions must be age-appropriate for the class level provided.
   Junior secondary (JSS 1-3) is roughly ages 10-14. Senior secondary
   (SS 1-3) is roughly ages 14-18.
4. Never include content promoting violence, discrimination, religious
   intolerance, or anything inappropriate for a school examination.
5. QUESTION TYPE RULES:
   - OBJECTIVE: Each question must have exactly 4 options (A, B, C, D).
     One option must be unambiguously correct. Options must be plausible
     distractors — not obviously wrong. Never repeat a distractor across
     questions. The "answer" field must be exactly "A", "B", "C", or "D".
   - THEORY: Open-ended questions requiring structured written answers.
     Each question must include a "markingGuide" with 3-5 bullet points
     a marker would use to award marks. Questions must be answerable using
     only the Nigerian school curriculum for this class and subject.
   - ESSAY: Extended response questions. Each question must include a
     "markingGuide" with a rubric covering content (50%), organisation
     (30%), and language (20%). Specify expected length in words.
6. DIFFICULTY:
   - EASY: recall and identification. Students who attended class can answer.
   - MEDIUM: application and simple analysis. Requires understanding, not
     just memory.
   - HARD: synthesis, evaluation, multi-step reasoning. WAEC/NECO final
     exam standard.
7. MATHEMATICAL NOTATION:
   Whenever your output contains math, express it in LaTeX inside $...$
   (inline) or $$...$$ (block). Plain-text math like "1/2", "x^2", or
   "sqrt(16)" is BANNED. Always use $\\frac{1}{2}$, $x^{2}$, $\\sqrt{16}$.
   Apply across all fields including question text, options, and markingGuide.
   Use ₦ for Naira, never $.
8. VARIETY: No two questions in the same set may test exactly the same
   concept from the same angle. Spread across different aspects of the topic.
9. NUMBERING: Questions are numbered 1 to N in the output array. Do not
   include the number inside the "question" text field.
10. WAEC/NECO ALIGNMENT:
    For senior secondary classes (SS 1-3), question style must match the
    format a student would see in WAEC or NECO examinations for this subject.
    For junior secondary (JSS 1-3), match BECE style.

OUTPUT FORMAT:
Respond with ONLY valid JSON matching this exact shape — no preamble, no
markdown fences, no commentary.

For OBJECTIVE questions:
{
  "title": "string — e.g. 'JSS 2 Mathematics — Fractions Objective Test'",
  "questionType": "objective",
  "subject": "string",
  "class": "string",
  "topic": "string",
  "duration": number | null,
  "questions": [
    {
      "question": "string — question text only, no number prefix",
      "options": { "A": "string", "B": "string", "C": "string", "D": "string" },
      "answer": "A",
      "difficulty": "easy"
    }
  ]
}

For THEORY questions:
{
  "title": "string",
  "questionType": "theory",
  "subject": "string",
  "class": "string",
  "topic": "string",
  "duration": number | null,
  "questions": [
    {
      "question": "string",
      "marks": number,
      "markingGuide": ["string", "string", "string"],
      "difficulty": "easy"
    }
  ]
}

For ESSAY questions:
{
  "title": "string",
  "questionType": "essay",
  "subject": "string",
  "class": "string",
  "topic": "string",
  "duration": number | null,
  "questions": [
    {
      "question": "string",
      "marks": number,
      "expectedWordCount": number,
      "markingGuide": {
        "content": "string",
        "organisation": "string",
        "language": "string"
      },
      "difficulty": "easy"
    }
  ]
}

If you cannot generate JSON matching this shape, respond with:
{"error": "string — brief reason"}`;

// batch-3-phase-3a-question-builder
function buildQuestionUserMessage({ classObj, subject, topic, questionType, count, difficulty, duration, markPerQuestion, session, additionalNotes }) {
  const lines = [
    `Generate ${count} ${difficulty} ${questionType} exam question(s) with the following details:`,
    '',
    `Class: ${classObj.name} (${classObj.level || 'level not specified'})`,
    `Subject: ${subject.name}`,
    `Topic: ${topic}`,
    `Question type: ${questionType}`,
    `Number of questions: ${count}`,
    `Difficulty: ${difficulty}`,
    `Duration: ${duration ? duration + ' minutes' : 'not specified'}`,
    `Marks per question: ${markPerQuestion || 'not specified'}`,
    `Term: ${session.currentTerm} (${session.name})`,
  ];
  if (additionalNotes && additionalNotes.trim()) {
    lines.push('');
    lines.push(`Teacher's notes: ${additionalNotes.trim()}`);
  }
  return lines.join('\n');
}

// batch-3-phase-3a-question-validator
function isValidAssessment(obj, questionType) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.title !== 'string' || !obj.title.trim()) return false;
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return false;
  for (const q of obj.questions) {
    if (!q || typeof q !== 'object') return false;
    if (typeof q.question !== 'string' || !q.question.trim()) return false;
    if (questionType === 'objective') {
      if (!q.options || typeof q.options !== 'object') return false;
      if (!['A','B','C','D'].includes(q.answer)) return false;
    }
    if (questionType === 'theory') {
      if (!Array.isArray(q.markingGuide) || q.markingGuide.length === 0) return false;
    }
    if (questionType === 'essay') {
      if (!q.markingGuide || typeof q.markingGuide !== 'object') return false;
    }
  }
  return true;
}

/**
 * Generate exam questions.
 * Throws same error-code surface as generateLessonNote / generateSchemeOfWork.
 */
async function generateExamQuestions(params) {
  const userMessage = buildQuestionUserMessage(params);
  const generatedAt = new Date().toISOString();

  let result;
  try {
    result = await _callAnthropicWithSystem(QUESTION_SYSTEM_PROMPT, userMessage, QUESTION_MAX_TOKENS, TEMPERATURE);
  } catch (err) {
    if (err.code === 'NO_API_KEY') throw err;
    throw classifyAnthropicError(err);
  }

  let text = stripFences(result.text);
  console.error('[generateExamQuestions] first response:', {
    stopReason:   result.stopReason,
    inputTokens:  result.inputTokens,
    outputTokens: result.outputTokens,
    textLength:   text.length,
    textPreview:  text.length > 500 ? text.slice(0, 250) + ' ... ' + text.slice(-250) : text,
  });

  if (text === 'I can only help with Nigerian school lesson planning.') {
    const err = new Error('AI refused the request');
    err.code = 'AI_REFUSED';
    throw err;
  }

  if (result.stopReason === 'max_tokens') {
    console.error('[generateExamQuestions] truncated at max_tokens:', { outputTokens: result.outputTokens });
    const err = new Error('AI output truncated at max_tokens (' + result.outputTokens + ' tokens)');
    err.code = 'AI_TRUNCATED';
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    let retry;
    try {
      retry = await _callAnthropicWithSystem(QUESTION_SYSTEM_PROMPT, userMessage, QUESTION_MAX_TOKENS, 0.2);
    } catch (err) {
      if (err.code === 'NO_API_KEY') throw err;
      throw classifyAnthropicError(err);
    }
    text = stripFences(retry.text);
    if (retry.stopReason === 'max_tokens') {
      const err = new Error('AI output truncated on retry');
      err.code = 'AI_TRUNCATED';
      throw err;
    }
    try {
      parsed = JSON.parse(text);
    } catch (e2) {
      const err = new Error('AI returned malformed JSON twice');
      err.code = 'AI_MALFORMED';
      throw err;
    }
    result.inputTokens  += retry.inputTokens;
    result.outputTokens += retry.outputTokens;
  }

  if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
    const err = new Error('AI returned error: ' + parsed.error);
    err.code = 'AI_ERROR_OBJECT';
    err.detail = parsed.error;
    throw err;
  }

  if (!isValidAssessment(parsed, params.questionType)) {
    console.error('[generateExamQuestions] AI_INVALID (no retry):', {
      hasTitle:     typeof parsed?.title === 'string',
      hasQuestions: Array.isArray(parsed?.questions),
      count:        Array.isArray(parsed?.questions) ? parsed.questions.length : null,
      topLevelKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
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


// batch-3-phase-3c-end-of-term-generator
// ───────────────────────────────────────────────────────────────────────────
// End-of-Term Exam generation — Phase 3.3c.
// Generates a combined paper: objective + theory + essay in one call.
// ───────────────────────────────────────────────────────────────────────────

const END_OF_TERM_MAX_TOKENS = 12000;

// batch-3-phase-3c-end-of-term-prompt
const END_OF_TERM_SYSTEM_PROMPT = `You are Klassrun, an AI assistant built exclusively for Nigerian school teachers.
You generate complete end-of-term examination papers for Nigerian schools,
aligned to the Nigerian curriculum (NERDC framework, WAEC and NECO standards
for senior classes, BECE standards for junior classes).

STRICT RULES:
1. You ONLY generate exam papers for Nigerian schools. If asked to do anything
   else, reply with exactly: "I can only help with Nigerian school lesson planning."
2. Nigerian English spelling. Use Naira (₦) for monetary examples. Reference
   Nigerian contexts (places, names, historical events) where natural.
3. Age-appropriate: JSS 1-3 is ages 10-14. SS 1-3 is ages 14-18.
4. Never include violence, discrimination, religious intolerance, or anything
   inappropriate for a school examination paper.
5. COVERAGE: Questions MUST be spread across ALL topics provided. Do not
   concentrate questions on one or two topics. Distribute proportionally —
   if 5 topics are given and 40 objective questions requested, aim for
   8 questions per topic.
6. OBJECTIVE RULES: Exactly 4 options (A, B, C, D). One unambiguous correct
   answer. Plausible distractors — not obviously wrong. Answer field must be
   exactly "A", "B", "C", or "D". Include which topic each question covers.
7. THEORY RULES: Each question needs a markingGuide (3-5 bullet points a
   marker would use to award marks). Include which topic each question covers.
8. ESSAY RULES: Each question needs a markingGuide covering content (50%),
   organisation (30%), and language (20%). Specify expected word count.
   Include which topic each question covers.
9. MATH NOTATION: All math in LaTeX — $...$ inline, $$...$$ block.
   Plain-text math like "1/2", "x^2" is BANNED. Use ₦ for Naira, never $.
10. WAEC/NECO ALIGNMENT: SS 1-3 must match WAEC/NECO exam style.
    JSS 1-3 must match BECE style.
11. If objectiveCount is 0, omit the "objective" section entirely.
    If theoryCount is 0, omit the "theory" section entirely.
    If essayCount is 0, omit the "essay" section entirely.
    Only include sections that have questions.

OUTPUT FORMAT — respond with ONLY valid JSON, no preamble, no markdown fences:

{
  "title": "string — e.g. 'JSS 2 Mathematics First Term Examination 2025/2026'",
  "subject": "string",
  "class": "string",
  "term": "string",
  "sessionName": "string",
  "duration": number,
  "totalMarks": number,
  "topicsCovered": ["string"],
  "sections": {
    "objective": {
      "instructions": "string — e.g. 'Answer ALL questions. Each correct answer = 1 mark.'",
      "questions": [
        {
          "question": "string",
          "options": { "A": "string", "B": "string", "C": "string", "D": "string" },
          "answer": "A",
          "topic": "string",
          "difficulty": "easy"
        }
      ]
    },
    "theory": {
      "instructions": "string — e.g. 'Answer ANY 3 questions. Each question = 10 marks.'",
      "questions": [
        {
          "question": "string",
          "marks": number,
          "topic": "string",
          "markingGuide": ["string"],
          "difficulty": "easy"
        }
      ]
    },
    "essay": {
      "instructions": "string",
      "questions": [
        {
          "question": "string",
          "marks": number,
          "topic": "string",
          "expectedWordCount": number,
          "markingGuide": { "content": "string", "organisation": "string", "language": "string" },
          "difficulty": "easy"
        }
      ]
    }
  }
}

If you cannot generate JSON matching this shape, respond with:
{"error": "string — brief reason"}`;

// batch-3-phase-3c-end-of-term-builder
function buildEndOfTermUserMessage({ classObj, subject, topics, objectiveCount, theoryCount, essayCount, difficulty, duration, session, additionalNotes }) {
  const lines = [
    'Generate an end-of-term examination paper with the following details:',
    '',
    `Class: ${classObj.name} (${classObj.level || 'level not specified'})`,
    `Subject: ${subject.name}`,
    `Term: ${session.currentTerm} (${session.name})`,
    `Duration: ${duration || 180} minutes`,
    `Difficulty: ${difficulty || 'medium'}`,
    '',
    'Topics covered this term (spread questions across ALL of these):',
  ];
  topics.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
  lines.push('');
  lines.push('Question breakdown:');
  if (objectiveCount > 0) lines.push(`  Objective (MCQ): ${objectiveCount} questions`);
  if (theoryCount > 0)    lines.push(`  Theory: ${theoryCount} questions`);
  if (essayCount > 0)     lines.push(`  Essay: ${essayCount} questions`);
  if (additionalNotes && additionalNotes.trim()) {
    lines.push('');
    lines.push(`Teacher's notes: ${additionalNotes.trim()}`);
  }
  return lines.join('\n');
}

// batch-3-phase-3c-end-of-term-validator
function isValidEndOfTermExam(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.title !== 'string' || !obj.title.trim()) return false;
  if (!obj.sections || typeof obj.sections !== 'object') return false;
  // At least one section must be present
  const { objective, theory, essay } = obj.sections;
  const hasObjective = objective && Array.isArray(objective.questions) && objective.questions.length > 0;
  const hasTheory    = theory    && Array.isArray(theory.questions)    && theory.questions.length > 0;
  const hasEssay     = essay     && Array.isArray(essay.questions)     && essay.questions.length > 0;
  if (!hasObjective && !hasTheory && !hasEssay) return false;
  if (hasObjective) {
    for (const q of objective.questions) {
      if (!q.question || !q.options || !['A','B','C','D'].includes(q.answer)) return false;
    }
  }
  if (hasTheory) {
    for (const q of theory.questions) {
      if (!q.question || !Array.isArray(q.markingGuide)) return false;
    }
  }
  if (hasEssay) {
    for (const q of essay.questions) {
      if (!q.question || !q.markingGuide) return false;
    }
  }
  return true;
}

/**
 * Generate a combined end-of-term exam paper.
 * Throws same error-code surface as generateExamQuestions.
 */
async function generateEndOfTermExam(params) {
  const userMessage = buildEndOfTermUserMessage(params);
  const generatedAt = new Date().toISOString();

  let result;
  try {
    result = await _callAnthropicWithSystem(END_OF_TERM_SYSTEM_PROMPT, userMessage, END_OF_TERM_MAX_TOKENS, TEMPERATURE);
  } catch (err) {
    if (err.code === 'NO_API_KEY') throw err;
    throw classifyAnthropicError(err);
  }

  let text = stripFences(result.text);
  console.error('[generateEndOfTermExam] first response:', {
    stopReason:   result.stopReason,
    inputTokens:  result.inputTokens,
    outputTokens: result.outputTokens,
    textLength:   text.length,
    textPreview:  text.length > 500 ? text.slice(0, 250) + ' ... ' + text.slice(-250) : text,
  });

  if (text === 'I can only help with Nigerian school lesson planning.') {
    const err = new Error('AI refused the request');
    err.code = 'AI_REFUSED';
    throw err;
  }

  if (result.stopReason === 'max_tokens') {
    const err = new Error('AI output truncated at max_tokens (' + result.outputTokens + ' tokens)');
    err.code = 'AI_TRUNCATED';
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    let retry;
    try {
      retry = await _callAnthropicWithSystem(END_OF_TERM_SYSTEM_PROMPT, userMessage, END_OF_TERM_MAX_TOKENS, 0.2);
    } catch (err) {
      if (err.code === 'NO_API_KEY') throw err;
      throw classifyAnthropicError(err);
    }
    text = stripFences(retry.text);
    if (retry.stopReason === 'max_tokens') {
      const err = new Error('AI output truncated on retry');
      err.code = 'AI_TRUNCATED';
      throw err;
    }
    try {
      parsed = JSON.parse(text);
    } catch (e2) {
      const err = new Error('AI returned malformed JSON twice');
      err.code = 'AI_MALFORMED';
      throw err;
    }
    result.inputTokens  += retry.inputTokens;
    result.outputTokens += retry.outputTokens;
  }

  if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
    const err = new Error('AI returned error: ' + parsed.error);
    err.code = 'AI_ERROR_OBJECT';
    err.detail = parsed.error;
    throw err;
  }

  if (!isValidEndOfTermExam(parsed)) {
    console.error('[generateEndOfTermExam] AI_INVALID (no retry):', {
      hasTitle:    typeof parsed?.title === 'string',
      hasSections: !!parsed?.sections,
      topLevelKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
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
  generateSchemeOfWork,
  generateExamQuestions,
  generateEndOfTermExam,
  ANTHROPIC_MODEL,
  // exported for testing — hotfix-batch-3-export-generators
  _internals: {
    SYSTEM_PROMPT,
    SCHEME_SYSTEM_PROMPT,
    buildSchemeUserMessage,
    isValidSchemeOfWork,
    buildUserMessage,
    stripFences,
    isValidLessonNote,
  },
};
