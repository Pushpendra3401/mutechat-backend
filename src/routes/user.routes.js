const express = require('express');
const router = express.Router();
const {
  updateProfile,
  updateAvatar,
  searchUsers,
  getUserProfile,
  updateFCMToken,
  deleteAccount,
} = require('../controllers/user.controller');
const { protect } = require('../middlewares/auth.middleware');
const upload = require('../middlewares/upload.middleware');

router.use(protect);

router.get('/profile/:id', getUserProfile);
router.put('/profile', updateProfile);
router.post('/avatar', upload.single('avatar'), updateAvatar);
router.get('/search', searchUsers);
router.post('/fcm-token', updateFCMToken);
router.delete('/account', deleteAccount);

module.exports = router;
