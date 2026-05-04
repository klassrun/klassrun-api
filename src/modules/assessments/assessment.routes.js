const router = require('express').Router();
const { authenticate } = require('../../middleware/auth');

// Placeholder — will be built next
router.get('/', authenticate, async (req, res) => {
  res.json({ message: 'Assessments endpoint ready', assessments: [] });
});

module.exports = router;
