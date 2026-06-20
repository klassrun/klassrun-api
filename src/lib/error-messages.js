// src/lib/error-messages.js
// hs-err-messages
//
// Maps any thrown error to a friendly, human message + status for the client.
// Internals (stack, error code, raw message) NEVER reach the client — they are
// logged server-side by the error handler. Controllers that set err.status keep
// their own message; everything unexpected gets a warm, non-scary default.

const GENERIC =
  'Something went wrong on our end. Please try again — and contact support if it keeps happening.';

function fromPrisma(err) {
  switch (err.code) {
    case 'P2002': {
      const t = err.meta && err.meta.target;
      const target = Array.isArray(t) ? t.join(',') : String(t || '');
      if (/email/i.test(target)) {
        return { status: 409, message: 'That email is already registered. Try logging in instead.' };
      }
      return { status: 409, message: 'That looks like it already exists — it may have been saved already.' };
    }
    case 'P2025':
      return { status: 404, message: "We couldn't find what you were looking for. It may have been removed." };
    case 'P2003':
      return { status: 409, message: "This is still linked to other records, so it can't be changed yet." };
    case 'P2021':
    case 'P2022':
      return { status: 503, message: "We're updating things on our end — please try again in a moment." };
    default:
      return null;
  }
}

function friendlyError(err) {
  if (!err) return { status: 500, message: GENERIC };

  if (err.code && /^P\d{4}$/.test(String(err.code))) {
    const mapped = fromPrisma(err);
    if (mapped) return mapped;
  }

  if (err.name === 'PrismaClientValidationError') {
    return { status: 400, message: "Some of the information didn't look right. Please check and try again." };
  }

  if (err.type === 'entity.parse.failed') {
    return { status: 400, message: 'We could not read that request. Please try again.' };
  }

  if (typeof err.message === 'string' && err.message.startsWith('CORS')) {
    return { status: 403, message: 'This request was blocked for security reasons.' };
  }

  if (typeof err.status === 'number') {
    return { status: err.status, message: err.message || GENERIC };
  }

  return { status: 500, message: GENERIC };
}

module.exports = { friendlyError, GENERIC };
