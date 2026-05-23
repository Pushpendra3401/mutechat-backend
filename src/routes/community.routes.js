const express = require('express');
const router = express.Router();
const communityController = require('../controllers/community.controller');
const { protect } = require('../middlewares/auth.middleware');

router.use(protect);

router.get('/', communityController.getCommunities);
router.post('/', communityController.createCommunity);
router.post('/:communityId/join', communityController.joinCommunity);
router.post('/:communityId/leave', communityController.leaveCommunity);
router.get('/:communityId/messages', communityController.getCommunityMessages);

module.exports = router;
