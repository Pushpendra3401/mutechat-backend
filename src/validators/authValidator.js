const { body, validationResult } = require('express-validator');
const ApiError = require('../utils/ApiError');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }
  const extractedErrors = [];
  errors.array().map((err) => extractedErrors.push({ [err.path]: err.msg }));

  console.error('[Auth] Validation failed:', JSON.stringify(extractedErrors));
  throw new ApiError(422, 'Validation failed', extractedErrors);
};

exports.sendOTPValidator = [
  body('mobileNumber')
    .notEmpty().withMessage('Mobile number is required')
    .trim()
    .custom((value) => {
      // Normalize to +91XXXXXXXXXX
      let digits = value.replace(/\D/g, '');
      if (digits.length === 10) {
        return true;
      }
      if (digits.length === 12 && digits.startsWith('91')) {
        return true;
      }
      throw new Error('Invalid Indian mobile number. Must be 10 digits.');
    }),
  validate,
];

exports.verifyOTPValidator = [
  body('mobileNumber')
    .notEmpty().withMessage('Mobile number is required')
    .trim()
    .custom((value) => {
      let digits = value.replace(/\D/g, '');
      if (digits.length === 10 || (digits.length === 12 && digits.startsWith('91'))) {
        return true;
      }
      throw new Error('Invalid Indian mobile number format');
    }),
  body('otp')
    .notEmpty().withMessage('OTP is required')
    .isLength({ min: 4, max: 6 }).withMessage('OTP must be 4-6 digits'),
  body('name')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  validate,
];
