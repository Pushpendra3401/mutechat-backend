const User = require('../models/user.model');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const twilioService = require('../services/twilioService');
const jwtService = require('../services/jwtService');

/**
 * @desc    Register a new user (Legacy/Email flow - DEPRECATED)
 * @route   POST /auth/register
 * @access  Public
 */
const registerUser = asyncHandler(async (req, res) => {
  throw new ApiError(410, 'Email registration is deprecated. Please use OTP.');
});

/**
 * @desc    Login user (Legacy/Email flow - DEPRECATED)
 * @route   POST /auth/login
 * @access  Public
 */
const loginUser = asyncHandler(async (req, res) => {
  throw new ApiError(410, 'Email login is deprecated. Please use OTP.');
});

/**
 * @desc    Send OTP to mobile number
 * @route   POST /auth/send-otp
 * @access  Public
 */
const sendOTP = asyncHandler(async (req, res) => {
  const { mobileNumber } = req.body;
  if (!mobileNumber) {
    throw new ApiError(400, 'Mobile number is required');
  }

  const otpSent = await twilioService.sendOTP(mobileNumber);
  if (!otpSent) {
    throw new ApiError(500, 'Failed to send OTP');
  }

  res.status(200).json(new ApiResponse(200, null, 'OTP sent successfully'));
});

/**
 * @desc    Verify OTP and Register/Login User
 * @route   POST /auth/verify-otp
 * @access  Public
 */
const verifyOtp = asyncHandler(async (req, res) => {
  const { mobileNumber, otp, name } = req.body;

  console.log('[Auth] Verify OTP request:', { mobileNumber, otp, name });

  if (!mobileNumber || !otp) {
    throw new ApiError(400, 'Mobile number and OTP are required');
  }

  // 1. Verify OTP with Twilio
  const isVerified = await twilioService.verifyOTP(mobileNumber, otp);
  if (!isVerified) {
    throw new ApiError(400, 'Invalid or expired OTP');
  }

  // 2. Find or create user by mobile number
  let user = await User.findOne({ mobileNumber });

  if (!user) {
    if (!name) {
      console.error('[Auth] Registration failed: Name missing for mobile', mobileNumber);
      throw new ApiError(400, 'Name is required for new registration via OTP');
    }
    
    // Create new user (No email or password required anymore)
    user = await User.create({
      mobileNumber,
      name,
      onlineStatus: true,
    });
    console.log('[Auth] New user created:', user._id);
  } else {
    // Existing user login
    user.onlineStatus = true;
    user.lastSeen = Date.now();
    await user.save();
    console.log('[Auth] Existing user logged in:', user._id);
  }

  const token = user.getSignedJwtToken();

  res.status(200).json(
    new ApiResponse(200, {
      user: {
        id: user._id,
        name: user.name,
        mobileNumber: user.mobileNumber,
        avatar: user.avatar,
      },
      token,
    }, 'Authentication successful')
  );
});

/**
 * @desc    Get current logged in user
 * @route   GET /auth/me
 * @access  Private
 */
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  res.status(200).json(new ApiResponse(200, user, 'User profile fetched successfully'));
});

/**
 * @desc    Logout User
 * @route   POST /auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (user) {
    user.onlineStatus = false;
    user.lastSeen = Date.now();
    await user.save();
  }
  res.status(200).json(new ApiResponse(200, null, 'Logged out successfully'));
});

/**
 * @desc    Refresh Token
 * @route   POST /auth/refresh-token
 * @access  Public
 */
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    throw new ApiError(401, 'Refresh token is required');
  }

  try {
    const decoded = jwtService.verifyToken(refreshToken);
    const user = await User.findById(decoded.id);
    if (!user) {
      throw new ApiError(401, 'Invalid refresh token');
    }

    const newAccessToken = jwtService.generateAccessToken(user);
    const newRefreshToken = jwtService.generateRefreshToken(user);

    res.status(200).json(new ApiResponse(200, { accessToken: newAccessToken, refreshToken: newRefreshToken }, 'Token refreshed'));
  } catch (error) {
    throw new ApiError(401, 'Invalid refresh token');
  }
});

module.exports = {
  registerUser,
  loginUser,
  sendOTP,
  verifyOtp,
  getMe,
  logout,
  refreshToken
};
