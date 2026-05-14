const mongoose = require('mongoose');

const callSchema = new mongoose.Schema(
  {
    caller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['audio', 'video'],
      required: true,
    },
    status: {
      type: String,
      enum: ['initiated', 'ringing', 'accepted', 'rejected', 'missed', 'ended', 'busy'],
      default: 'initiated',
    },
    channelName: {
      type: String,
      required: true,
    },
    startTime: {
      type: Date,
    },
    endTime: {
      type: Date,
    },
    duration: {
      type: Number, // In seconds
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Call', callSchema);
