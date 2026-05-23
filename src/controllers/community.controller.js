const Community = require('../models/community.model');
const Message = require('../models/message.model');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');

/**
 * @desc    Get all communities the user is part of
 * @route   GET /api/v1/community
 * @access  Private
 */
exports.getCommunities = asyncHandler(async (req, res) => {
  const communities = await Community.find({
    members: { $in: [req.user._id] }
  })
    .populate('createdBy', 'name avatar')
    .populate('members', 'name avatar')
    .populate('lastMessage')
    .sort('-updatedAt');

  res.status(200).json(new ApiResponse(200, communities, 'Communities fetched successfully'));
});

/**
 * @desc    Create a new community
 * @route   POST /api/v1/community
 * @access  Private
 */
exports.createCommunity = asyncHandler(async (req, res) => {
  const { name, description, icon } = req.body;
  const userId = req.user._id;

  if (!name || !description) {
    throw new ApiError(400, 'Name and description are required');
  }

  const community = await Community.create({
    name,
    description,
    icon: icon || 'group',
    createdBy: userId,
    members: [userId],
    admins: [userId],
  });

  res.status(201).json(new ApiResponse(201, community, 'Community created successfully'));
});

/**
 * @desc    Join a community
 * @route   POST /api/v1/community/:communityId/join
 * @access  Private
 */
exports.joinCommunity = asyncHandler(async (req, res) => {
  const { communityId } = req.params;
  const userId = req.user._id;

  const community = await Community.findById(communityId);
  if (!community) {
    throw new ApiError(404, 'Community not found');
  }

  if (community.members.includes(userId)) {
    throw new ApiError(400, 'You are already a member of this community');
  }

  community.members.push(userId);
  await community.save();

  res.status(200).json(new ApiResponse(200, community, 'Joined community successfully'));
});

/**
 * @desc    Leave a community
 * @route   POST /api/v1/community/:communityId/leave
 * @access  Private
 */
exports.leaveCommunity = asyncHandler(async (req, res) => {
  const { communityId } = req.params;
  const userId = req.user._id;

  const community = await Community.findById(communityId);
  if (!community) {
    throw new ApiError(404, 'Community not found');
  }

  community.members = community.members.filter(id => id.toString() !== userId.toString());
  community.admins = community.admins.filter(id => id.toString() !== userId.toString());

  if (community.members.length === 0) {
    await Community.findByIdAndDelete(communityId);
    return res.status(200).json(new ApiResponse(200, null, 'Community deleted as it has no members'));
  }

  await community.save();
  res.status(200).json(new ApiResponse(200, community, 'Left community successfully'));
});

/**
 * @desc    Get messages for a specific community
 * @route   GET /api/v1/community/:communityId/messages
 * @access  Private
 */
exports.getCommunityMessages = asyncHandler(async (req, res) => {
  const { communityId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  const messages = await Message.find({ community: communityId })
    .populate('sender', 'name avatar')
    .sort('-createdAt')
    .skip((page - 1) * limit)
    .limit(limit);

  res.status(200).json(new ApiResponse(200, messages, 'Community messages fetched successfully'));
});
