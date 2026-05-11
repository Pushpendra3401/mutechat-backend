const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
      trim: true,
    },
    mobileNumber: {
      type: String,
      required: [true, 'Please add a mobile number'],
      unique: true,
      trim: true,
    },
    email: {
      type: String,
      unique: true,
      sparse: true, // Allows multiple null/missing emails
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Please add a valid email',
      ],
    },
    password: {
      type: String,
      required: [true, 'Please add a password'],
      minlength: 6,
      select: false,
    },
    avatar: {
      type: String,
      default: 'https://res.cloudinary.com/drmr0arvz/image/upload/v1625050000/mutechat/defaults/avatar.png',
    },
    bio: {
      type: String,
      default: 'Available',
      maxlength: [100, 'Bio cannot be more than 100 characters'],
    },
    about: {
      type: String,
      default: 'Hey there! I am using MuteChat.',
      maxlength: [500, 'About cannot be more than 500 characters'],
    },
    onlineStatus: {
      type: Boolean,
      default: false,
    },
    fcmToken: {
      type: String,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    refreshToken: {
      type: String,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

// Encrypt password using bcrypt
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Sign JWT and return
userSchema.methods.getSignedJwtToken = function () {
  return jwt.sign({ id: this._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '30d',
  });
};

// Match user entered password to hashed password in database
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
