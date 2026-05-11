const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const User = require('../models/user.model');
const cloudinary = require('cloudinary').v2;

/**
 * @desc    Update user profile
 * @route   PUT /api/v1/users/profile
 * @access  Private
 */
exports.updateProfile = asyncHandler(async (req, res) => {
  const { name, bio, about } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user.id,
    { name, bio, about },
    { new: true, runValidators: true }
  );

  res.status(200).json(new ApiResponse(200, user, 'Profile updated successfully'));
});

/**
 * @desc    Update user avatar
 * @route   POST /api/v1/users/avatar
 * @access  Private
 */
exports.updateAvatar = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, 'Please upload an image');
  }

  const user = await User.findById(req.user.id);

  // If user already has an avatar that is not default, we could delete it from cloudinary
  // For now, just update with new one
  user.avatar = req.file.path; // Cloudinary URL from multer-storage-cloudinary
  await user.save();

  res.status(200).json(new ApiResponse(200, { avatar: user.avatar }, 'Avatar updated successfully'));
});

/**
 * @desc    Search users by name or mobile number
 * @route   GET /api/v1/users/search
 * @access  Private
 */
exports.searchUsers = asyncHandler(async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(200).json(new ApiResponse(200, [], 'Empty query'));
  }

  const users = await User.find({
    $and: [
      { _id: { $ne: req.user.id } }, // Exclude self
      {
        $or: [
          { name: { $regex: query, $options: 'i' } },
          { mobileNumber: { $regex: query, $options: 'i' } },
        ],
      },
    ],
  }).select('name mobileNumber avatar bio onlineStatus lastSeen');

  res.status(200).json(new ApiResponse(200, users, 'Users fetched successfully'));
});

/**
 * @desc    Get any user profile
 * @route   GET /api/v1/users/profile/:id
 * @access  Private
 */
exports.getUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('name mobileNumber avatar bio about onlineStatus lastSeen');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  res.status(200).json(new ApiResponse(200, user, 'User profile fetched successfully'));
});

/**
 * @desc    Update FCM Token
 * @route   PATCH /api/v1/users/fcm-token
 * @access  Private
 */
exports.updateFCMToken = asyncHandler(async (req, res) => {
  const { fcmToken } = req.body;

  if (!fcmToken) {
    throw new ApiError(400, 'FCM Token is required');
  }

  await User.findByIdAndUpdate(req.user.id, { fcmToken });

  res.status(200).json(new ApiResponse(200, null, 'FCM Token updated successfully'));
});
