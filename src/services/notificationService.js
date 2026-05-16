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
      callerAvatar: caller.avatar || '',
      channelName: callData.channelName,
      chatId: callData.chatId || '',
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    notification: {
      title: 'Incoming Call',
      body: `${caller.name} is calling you...`,
    },
    android: {
      priority: 'high',
      ttl: 30000, // 30 seconds
      notification: {
        channelId: 'mutechat_high_importance_channel',
        priority: 'max',
        fullScreenIntent: true,
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
    data: {
      type: 'chat',
      chatId: messageData.chatId.toString(),
      senderId: sender._id.toString(),
      senderName: sender.name,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    notification: {
      title: sender.name,
      body: messageData.text || (messageData.media ? 'Sent a photo' : 'New message'),
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'mutechat_high_importance_channel',
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
    data: {
      type: 'missed_call',
      senderId: caller._id.toString(),
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    notification: {
      title: 'Missed Call',
      body: `You missed a call from ${caller.name}`,
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'mutechat_high_importance_channel',
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
