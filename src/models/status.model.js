const mongoose = require('mongoose');

const statusSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  content: {
    url: String,
    type: {
      type: String,
      enum: ['image', 'video', 'text'],
      default: 'image'
    },
    text: String,
    thumbnail: String
  },
  seenBy: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    seenAt: {
      type: Date,
      default: Date.now
    }
  }],
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 } // Auto-delete by MongoDB after 24h
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Status', statusSchema);