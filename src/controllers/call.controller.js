const Call = require('../models/call.model');
const User = require('../models/user.model');
const agoraService = require('../services/agoraService');
const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');

/**
 * @desc    Get Call History
 * @route   GET /api/v1/call/history
 * @access  Private
 */
exports.getCallHistory = asyncHandler(async (req, res) => {
  const history = await Call.find({
    $or: [{ caller: req.user.id }, { receiver: req.user.id }],
  })
    .populate('caller', 'name avatar mobileNumber')
    .populate('receiver', 'name avatar mobileNumber')
    .sort('-createdAt');

  res.status(200).json(new ApiResponse(200, history, 'Call history fetched successfully'));
});

/**
 * @desc    Save Call Log
 * @route   POST /api/v1/call/history
 * @access  Private
 */
exports.saveCallLog = asyncHandler(async (req, res) => {
  const { callerId, receiverId, type, status, duration, startTime, endTime, channelName } = req.body;

  if (!callerId || !receiverId || !type) {
    throw new ApiError(400, 'Caller, receiver, and type are required');
  }

  const call = await Call.create({
    caller: callerId,
    receiver: receiverId,
    type,
    status: status || 'ended',
    duration: duration || 0,
    startTime: startTime || new Date(),
    endTime: endTime || new Date(),
    channelName: channelName || 'unknown',
  });

  const populatedCall = await Call.findById(call._id)
    .populate('caller', 'name avatar mobileNumber')
    .populate('receiver', 'name avatar mobileNumber');

  res.status(201).json(new ApiResponse(201, populatedCall, 'Call log saved successfully'));
});

/**
 * @desc    Generate Agora Token for a call
 * @route   POST /api/v1/call/token
 * @access  Private
 */
exports.getCallToken = asyncHandler(async (req, res) => {
  const { channelName, uid } = req.body;
  console.log(`[Agora] Token request for channel: ${channelName}, uid: ${uid}`);

  if (!channelName) {
    throw new ApiError(400, 'Channel name is required');
  }

  // Use 0 if uid is not provided (Agora allows 0 for any user)
  const tokenUid = uid || 0;
  
  try {
    const token = agoraService.generateToken(channelName, tokenUid);
    console.log(`[Agora] Generated token: ${token.substring(0, 10)}... for channel: ${channelName}`);
    res.status(200).json(new ApiResponse(200, { 
      token,
      appId: process.env.AGORA_APP_ID 
    }, 'Token generated successfully'));
  } catch (error) {
    console.error(`[Agora] Token generation failed: ${error.message}`);
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

/**
 * @desc    Clear Call History
 * @route   DELETE /api/v1/call/history
 * @access  Private
 */
exports.clearCallHistory = asyncHandler(async (req, res) => {
  await Call.deleteMany({
    $or: [{ caller: req.user.id }, { receiver: req.user.id }],
  });

  res.status(200).json(new ApiResponse(200, null, 'Call history cleared successfully'));
});

