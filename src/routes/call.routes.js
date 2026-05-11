const express = require('express');
const router = express.Router();
const callController = require('../controllers/call.controller');
const { protect } = require('../middlewares/auth.middleware');

router.use(protect);

router.post('/token', callController.getCallToken);
router.get('/history', callController.getCallHistory);

module.exports = router;
