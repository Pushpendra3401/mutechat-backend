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
  console.log(`[Chat] Fetching chats for user: ${req.user._id}`);
  const chats = await Chat.find({
    participants: { $in: [req.user._id] },
    lastMessage: { $ne: null } // ONLY show chats with at least one message
  })
    .populate('participants', 'name mobileNumber avatar onlineStatus lastSeen')
    .populate({
      path: 'lastMessage',
      populate: { path: 'sender', select: 'name' },
    })
    .sort('-updatedAt');

  console.log(`[Chat] Found ${chats.length} active chats for user ${req.user._id}`);
  res.status(200).json(new ApiResponse(200, chats, 'Chats fetched successfully'));
});

/**
 * @desc    Create or get a chat with another user
 * @route   POST /api/v1/chat
 * @access  Private
 */
exports.createOrGetChat = asyncHandler(async (req, res) => {
  const senderId = req.user._id;
  const { userId } = req.body;

  console.log(`[Chat] Incoming POST /chat request from ${senderId} to access chat with ${userId}`);

  if (!userId) {
    throw new ApiError(400, 'userId is required');
  }

  let chat = await Chat.findOne({
    participants: {
      $all: [senderId, userId],
      $size: 2,
    },
  });

  if (!chat) {
    chat = await Chat.create({
      participants: [senderId, userId],
    });

    console.log('[Chat] new chat created:', chat._id);
    return res.status(201).json(new ApiResponse(201, chat, 'Chat created successfully'));
  } else {
    console.log('[Chat] existing chat found:', chat._id);
    return res.status(200).json(new ApiResponse(200, chat, 'Existing chat found'));
  }
});

/**
 * @desc    Create a group chat
 * @route   POST /api/v1/chat/group
 * @access  Private
 */
exports.createGroupChat = asyncHandler(async (req, res) => {
  const { name, participants } = req.body;
  const adminId = req.user._id;

  if (!name || !participants || participants.length === 0) {
    throw new ApiError(400, 'Name and participants are required');
  }

  // Include admin in participants if not already there
  const allParticipants = [...new Set([...participants, adminId.toString()])];

  const chat = await Chat.create({
    name,
    isGroup: true,
    participants: allParticipants,
    admins: [adminId],
  });

  const fullChat = await Chat.findById(chat._id).populate('participants', 'name avatar');

  res.status(201).json(new ApiResponse(201, fullChat, 'Group chat created successfully'));
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

  // Security: Ensure user is a participant of the chat
  const chat = await Chat.findOne({
    _id: chatId,
    participants: { $in: [req.user._id] }
  });

  if (!chat) {
    throw new ApiError(403, 'You are not a participant of this chat');
  }

  const total = await Message.countDocuments({ chat: chatId });
  const messages = await Message.find({ chat: chatId })
    .sort('-createdAt')
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('sender', 'name avatar')
    .populate('replyTo');

  res.status(200).json(new ApiResponse(200, {
    messages: messages, // Removed .reverse() because frontend uses reverse: true
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

  let type = 'file';
  if (req.file.mimetype.startsWith('image/')) type = 'image';
  else if (req.file.mimetype.startsWith('video/')) type = 'video';
  else if (req.file.mimetype.startsWith('audio/')) type = 'audio';

  const media = {
    url: req.file.path,
    publicId: req.file.filename,
    type: type,
    fileName: req.file.originalname,
    size: req.file.size,
  };

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
