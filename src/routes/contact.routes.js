const express = require('express');
const router = express.Router();
const contactController = require('../controllers/contact.controller');
const { protect } = require('../middlewares/auth.middleware');

router.use(protect);

router.get('/', contactController.getContacts);
router.post('/request', contactController.sendRequest);
router.post('/accept', contactController.acceptRequest);

module.exports = router;
