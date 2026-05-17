const express = require('express');
const router = express.Router();
const statusController = require('../controllers/status.controller');
const { protect } = require('../middlewares/auth.middleware');
const { upload } = require('../config/cloudinary');

router.use(protect);

router.get('/', statusController.getStatuses);
router.post('/', upload.single('media'), statusController.createStatus);
router.post('/:statusId/seen', statusController.markStatusSeen);
router.delete('/:statusId', statusController.deleteStatus);

module.exports = router;