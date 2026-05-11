const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { protect } = require('../middlewares/auth.middleware');
const { upload } = require('../config/cloudinary');

router.use(protect);

router.get('/', chatController.getChats);
router.get('/search', chatController.searchUsers);
router.get('/:chatId/messages', chatController.getMessages);
router.post('/upload', upload.single('media'), chatController.uploadMedia);

module.exports = router;
