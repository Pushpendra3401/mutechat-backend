const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    chat: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chat',
      required: true,
    },
    text: {
      type: String,
      trim: true,
    },
    media: {
      url: String,
      publicId: String,
      type: {
        type: String,
        enum: ['image', 'audio', 'video', 'file'],
      },
      fileName: String,
      size: Number,
      duration: Number,
      thumbnail: String,
    },
    status: {
      type: String,
      enum: ['sending', 'sent', 'delivered', 'seen', 'failed'],
      default: 'sent',
    },
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
    },
    clientMessageId: {
      type: String,
      unique: true,
      sparse: true,
    },
  },
  {
    timestamps: true,
  }
);

// Performance Indexes for Scalability
messageSchema.index({ chat: 1, createdAt: -1 }); // Faster history loading
messageSchema.index({ receiver: 1, status: 1 }); // Faster delivered/seen updates
messageSchema.index({ sender: 1, createdAt: -1 }); // Faster sender history

module.exports = mongoose.model('Message', messageSchema);
