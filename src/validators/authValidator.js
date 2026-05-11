const { body, validationResult } = require('express-validator');
const ApiError = require('../utils/ApiError');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }
  const extractedErrors = [];
  errors.array().map((err) => extractedErrors.push({ [err.path]: err.msg }));

  throw new ApiError(422, 'Validation failed', extractedErrors);
};

exports.sendOTPValidator = [
  body('mobileNumber')
    .notEmpty().withMessage('Mobile number is required')
    .isMobilePhone().withMessage('Invalid mobile number format'),
  validate,
];

exports.verifyOTPValidator = [
  body('mobileNumber')
    .notEmpty().withMessage('Mobile number is required')
    .isMobilePhone().withMessage('Invalid mobile number format'),
  body('otp')
    .notEmpty().withMessage('OTP is required')
    .isLength({ min: 4, max: 6 }).withMessage('OTP must be 4-6 digits'),
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  validate,
];
