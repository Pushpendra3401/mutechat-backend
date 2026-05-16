const { messaging } = require('../config/firebase');

/**
 * [FCM] Logs a debug message with standard prefix
 */
const log = (msg) => console.log(`[FCM] ${msg}`);

/**
 * Sends a generic push notification
 */
const sendPushNotification = async (token, data, notification = null) => {
  if (!messaging) {
    log('Firebase Admin SDK not initialized');
    return null;
  }
  
  if (!token) {
    log('Missing FCM token');
    return null;
  }

  const message = {
    token: token,
    data: data,
    notification: notification,
    android: {
      priority: 'high',
    },
    apns: {
      payload: {
        aps: {
          contentAvailable: true,
        },
      },
    },
  };

  try {
    log('Sending push notification');
    const response = await messaging.send(message);
    log('Notification sent successfully');
    return response;
  } catch (error) {
    console.error('[FCM] Error sending push notification:', error.message);
    return null;
  }
};

/**
 * Sends an incoming call notification
 */
const sendCallNotification = async (receiverToken, caller, callData) => {
  if (!messaging) {
    log('Firebase Admin SDK not initialized');
    return null;
  }
  
  if (!receiverToken) {
    log('Missing FCM token');
    return null;
  }

  const message = {
    token: receiverToken,
    data: {
      type: 'call',
      callerId: caller._id.toString(),
      callerName: caller.name,
      chatId: callData.chatId || '',
      channelName: callData.channelName,
      callType: callData.type || 'video',
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'calls',
        sound: 'default',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
    },
  };

  try {
    log(`Sending push notification (call) to token ending in ...${receiverToken.slice(-5)}`);
    const response = await messaging.send(message);
    log('Notification sent successfully');
    return response;
  } catch (error) {
    console.error('[FCM] Error sending call notification:', error.message);
    return null;
  }
};

/**
 * Sends a chat message notification
 */
const sendMessageNotification = async (receiverToken, sender, messageData) => {
  if (!messaging) {
    log('Firebase Admin SDK not initialized');
    return null;
  }
  
  if (!receiverToken) {
    log('Missing FCM token');
    return null;
  }

  const message = {
    token: receiverToken,
    notification: {
      title: sender.name,
      body: messageData.text || (messageData.media ? 'Sent a photo' : 'New message'),
    },
    data: {
      type: 'chat',
      chatId: messageData.chatId.toString(),
      senderId: sender._id.toString(),
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'messages',
        sound: 'default',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
    },
  };

  try {
    log(`Sending push notification (message) from ${sender.name}`);
    const response = await messaging.send(message);
    log('Notification sent successfully');
    return response;
  } catch (error) {
    console.error('[FCM] Error sending message notification:', error.message);
    return null;
  }
};

/**
 * Sends a missed call notification
 */
const sendMissedCallNotification = async (receiverToken, caller) => {
  if (!messaging) {
    log('Firebase Admin SDK not initialized');
    return null;
  }
  
  if (!receiverToken) {
    log('Missing FCM token');
    return null;
  }

  const message = {
    token: receiverToken,
    notification: {
      title: 'Missed Call',
      body: `You missed a call from ${caller.name}`,
    },
    data: {
      type: 'missed_call',
      senderId: caller._id.toString(),
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'calls',
        sound: 'default',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
    },
  };

  try {
    log('Sending push notification (missed call)');
    await messaging.send(message);
    log('Notification sent successfully');
  } catch (error) {
    console.error('[FCM] Error sending missed call notification:', error.message);
  }
};

module.exports = {
  sendPushNotification,
  sendCallNotification,
  sendMessageNotification,
  sendMissedCallNotification,
};
