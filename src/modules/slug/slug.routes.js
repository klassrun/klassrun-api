// src/modules/slug/slug.routes.js
//
// Public endpoints — the school signup form uses these BEFORE the user has
// an account, so no authentication is required. They're read-only and
// can't leak any data (slug names are not sensitive).

const router = require('express').Router();
const { check, suggest, generate } = require('./slug.controller');

router.get('/check',    check);
router.get('/suggest',  suggest);
router.get('/generate', generate);

module.exports = router;
