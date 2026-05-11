const Call = require('../models/call.model');
const agoraService = require('../services/agoraService');
const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');

/**
 * @desc    Generate Agora Token for a call
 * @route   POST /api/v1/call/token
 * @access  Private
 */
exports.getCallToken = asyncHandler(async (req, res) => {
  const { channelName, uid } = req.body;

  if (!channelName) {
    throw new ApiError(400, 'Channel name is required');
  }

  // Use 0 if uid is not provided (Agora allows 0 for any user)
  const tokenUid = uid || 0;
  
  try {
    const token = agoraService.generateToken(channelName, tokenUid);
    res.status(200).json(new ApiResponse(200, { token }, 'Token generated successfully'));
  } catch (error) {
    throw new ApiError(500, error.message);
  }
});

/**
 * @desc    Get Call History
 * @route   GET /api/v1/call/history
 * @access  Private
 */
exports.getCallHistory = asyncHandler(async (req, res) => {
  const history = await Call.find({
    $or: [{ caller: req.user.id }, { receiver: req.user.id }],
  })
    .populate('caller', 'name profilePicture')
    .populate('receiver', 'name profilePicture')
    .sort('-createdAt');

  res.status(200).json(new ApiResponse(200, history, 'Call history fetched successfully'));
});
