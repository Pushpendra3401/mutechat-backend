const Chat = require('../models/chat.model');
const Message = require('../models/message.model');
const User = require('../models/user.model');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');

/**
 * @desc    Get all chats for current user
 * @route   GET /api/v1/chat
 * @access  Private
 */
exports.getChats = asyncHandler(async (req, res) => {
  const chats = await Chat.find({
    participants: { $in: [req.user.id] },
  })
    .populate('participants', 'name mobileNumber profilePicture onlineStatus lastSeen')
    .populate({
      path: 'lastMessage',
      populate: { path: 'sender', select: 'name' },
    })
    .sort('-updatedAt');

  res.status(200).json(new ApiResponse(200, chats, 'Chats fetched successfully'));
});

/**
 * @desc    Get messages for a specific chat
 * @route   GET /api/v1/chat/:chatId/messages
 * @access  Private
 */
exports.getMessages = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  const total = await Message.countDocuments({ chat: chatId });
  const messages = await Message.find({ chat: chatId })
    .sort('-createdAt')
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('sender', 'name profilePicture avatar')
    .populate('replyTo');

  res.status(200).json(new ApiResponse(200, {
    messages: messages.reverse(),
    pagination: {
      total,
      page,
      pages: Math.ceil(total / limit)
    }
  }, 'Messages fetched successfully'));
});

/**
 * @desc    Upload media and return URL
 * @route   POST /api/v1/chat/upload
 * @access  Private
 */
exports.uploadMedia = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, 'Please upload a file');
  }

  const media = {
    url: req.file.path,
    public_id: req.file.filename,
    type: req.file.mimetype.split('/')[0],
  };

  // Adjust audio type for Cloudinary
  if (req.file.mimetype.startsWith('audio')) media.type = 'audio';

  res.status(200).json(new ApiResponse(200, media, 'Media uploaded successfully'));
});

/**
 * @desc    Search users to start a new chat
 * @route   GET /api/v1/chat/search?query=...
 * @access  Private
 */
exports.searchUsers = asyncHandler(async (req, res) => {
  const { query } = req.query;
  if (!query) {
    return res.status(200).json(new ApiResponse(200, [], 'Empty search query'));
  }

  const users = await User.find({
    $and: [
      { _id: { $ne: req.user.id } },
      {
        $or: [
          { name: { $regex: query, $options: 'i' } },
          { mobileNumber: { $regex: query, $options: 'i' } },
        ],
      },
    ],
  }).select('name mobileNumber profilePicture onlineStatus lastSeen');

  res.status(200).json(new ApiResponse(200, users, 'Users searched successfully'));
});
