const Contact = require('../models/contact.model');
const User = require('../models/user.model');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');

/**
 * @desc    Send a friend request
 * @route   POST /api/v1/contact/request
 * @access  Private
 */
exports.sendRequest = asyncHandler(async (req, res) => {
  const { contactId } = req.body;
  const userId = req.user._id;

  if (userId.toString() === contactId) {
    throw new ApiError(400, 'You cannot add yourself');
  }

  const existingRequest = await Contact.findOne({ user: userId, contact: contactId });
  if (existingRequest) {
    throw new ApiError(400, 'Request already sent or contact exists');
  }

  const request = await Contact.create({ user: userId, contact: contactId, status: 'pending' });

  res.status(201).json(new ApiResponse(201, request, 'Friend request sent'));
});

/**
 * @desc    Accept a friend request
 * @route   POST /api/v1/contact/accept
 * @access  Private
 */
exports.acceptRequest = asyncHandler(async (req, res) => {
  const { requestId } = req.body;
  const userId = req.user._id;

  const request = await Contact.findById(requestId);
  if (!request || request.contact.toString() !== userId.toString()) {
    throw new ApiError(404, 'Request not found');
  }

  request.status = 'accepted';
  await request.save();

  // Create reciprocal contact for the other user
  await Contact.create({ user: userId, contact: request.user, status: 'accepted' });

  res.status(200).json(new ApiResponse(200, request, 'Friend request accepted'));
});

/**
 * @desc    Get all contacts
 * @route   GET /api/v1/contact
 * @access  Private
 */
exports.getContacts = asyncHandler(async (req, res) => {
  const contacts = await Contact.find({ user: req.user._id, status: 'accepted' })
    .populate('contact', 'name avatar onlineStatus lastSeen');

  res.status(200).json(new ApiResponse(200, contacts, 'Contacts fetched successfully'));
});
