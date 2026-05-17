const User = require('../models/user.model');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const twilioService = require('../services/twilioService');
const jwtService = require('../services/jwtService');

/**
 * Normalizes phone number to +91XXXXXXXXXX
 * @param {string} phone 
 * @returns {string}
 */
const normalizePhoneNumber = (phone) => {
  if (!phone) return phone;
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }
  return phone; // Should be caught by validator but fallback just in case
};

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
  let { mobileNumber } = req.body;
  if (!mobileNumber) {
    throw new ApiError(400, 'Mobile number is required');
  }

  mobileNumber = normalizePhoneNumber(mobileNumber);

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
  let { mobileNumber, otp, name } = req.body;

  console.log('[Auth] Login/signup request received:', { mobileNumber, otp, name });

  if (!mobileNumber || !otp) {
    console.error('[Auth] Missing mobileNumber or OTP');
    throw new ApiError(400, 'Mobile number and OTP are required');
  }

  mobileNumber = normalizePhoneNumber(mobileNumber);
  console.log('[Auth] Normalized phone:', mobileNumber);

  // 1. Verify OTP with Twilio
  const isVerified = await twilioService.verifyOTP(mobileNumber, otp);
  if (!isVerified) {
    console.error('[Auth] OTP verification failed for:', mobileNumber);
    throw new ApiError(400, 'Invalid or expired OTP');
  }

  console.log('[Auth] OTP verify success for:', mobileNumber);

  // 2. Find or create user by mobile number
  let user = await User.findOne({ mobileNumber });

  if (!user) {
    console.log('[Auth] Existing user NOT found. Attempting signup...');
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
    console.log('[Auth] Existing user found:', user.name, '(', user._id, ')');
    user.onlineStatus = true;
    user.lastSeen = Date.now();
    await user.save();
    console.log('[Auth] Existing user logged in successfully');
  }

  const token = user.getSignedJwtToken();
  console.log('[Auth] JWT generated for user:', user._id);

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
