const Status = require('../models/status.model');
const asyncHandler = require('../middlewares/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const User = require('../models/user.model');

/**
 * @desc    Create a new status
 * @route   POST /api/v1/status
 * @access  Private
 */
exports.createStatus = asyncHandler(async (req, res) => {
  const { text, type } = req.body;
  
  let content = {
    type: type || 'image',
    text: text
  };

  if (req.file) {
    content.url = req.file.path;
    content.thumbnail = req.file.path; // Could generate real thumbnail later
  } else if (type !== 'text') {
    throw new ApiError(400, 'Media file is required for image/video status');
  }

  const status = await Status.create({
    user: req.user._id,
    content,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
  });

  res.status(201).json(new ApiResponse(201, status, 'Status created successfully'));
});

/**
 * @desc    Get statuses from contacts (following/connected)
 * @route   GET /api/v1/status
 * @access  Private
 */
exports.getStatuses = asyncHandler(async (req, res) => {
  // For MuteChat, we'll show statuses from all users you have a chat with 
  // or just all users for simplicity in this MVP
  const statuses = await Status.find({
    expiresAt: { $gt: new Date() }
  })
  .populate('user', 'name avatar')
  .sort('-createdAt');

  // Group by user
  const groupedStatuses = statuses.reduce((acc, status) => {
    const userId = status.user._id.toString();
    if (!acc[userId]) {
      acc[userId] = {
        user: status.user,
        items: []
      };
    }
    acc[userId].items.push(status);
    return acc;
  }, {});

  res.status(200).json(new ApiResponse(200, Object.values(groupedStatuses), 'Statuses fetched successfully'));
});

/**
 * @desc    Mark status as seen
 * @route   POST /api/v1/status/:statusId/seen
 * @access  Private
 */
exports.markStatusSeen = asyncHandler(async (req, res) => {
  const status = await Status.findById(req.params.statusId);
  if (!status) {
    throw new ApiError(404, 'Status not found');
  }

  const alreadySeen = status.seenBy.find(s => s.user.toString() === req.user._id.toString());
  if (!alreadySeen) {
    status.seenBy.push({ user: req.user._id });
    await status.save();
  }

  res.status(200).json(new ApiResponse(200, null, 'Status marked as seen'));
});

/**
 * @desc    Delete status
 * @route   DELETE /api/v1/status/:statusId
 * @access  Private
 */
exports.deleteStatus = asyncHandler(async (req, res) => {
  const status = await Status.findById(req.params.statusId);
  if (!status) {
    throw new ApiError(404, 'Status not found');
  }

  if (status.user.toString() !== req.user._id.toString()) {
    throw new ApiError(403, 'Not authorized to delete this status');
  }

  await status.remove();
  res.status(200).json(new ApiResponse(200, null, 'Status deleted successfully'));
});