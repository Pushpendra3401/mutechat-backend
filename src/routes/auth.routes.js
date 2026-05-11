const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  sendOTP,
  verifyOtp,
  getMe,
  logout,
  refreshToken
} = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth.middleware');
const { 
  sendOTPValidator, 
  verifyOTPValidator 
} = require('../validators/authValidator');

// Public routes
router.post('/register', verifyOTPValidator, registerUser);
router.post('/login', verifyOTPValidator, loginUser);
router.post('/send-otp', sendOTPValidator, sendOTP);
router.post('/verify-otp', verifyOTPValidator, verifyOtp);
router.post('/refresh-token', refreshToken);

// Protected routes
router.get('/me', protect, getMe);
router.post('/logout', protect, logout);

module.exports = router;
