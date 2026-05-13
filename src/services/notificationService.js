const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
// Note: You need to place your firebase-service-account.json in the src/config directory
try {
  const serviceAccount = require('../config/firebase-service-account.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('[Firebase] Admin SDK initialized successfully');
} catch (error) {
  console.warn('[Firebase] Warning: Firebase Admin SDK not initialized. Push notifications will be disabled.');
  console.warn('[Firebase] Error details: ', error.message);
}

const sendPushNotification = async (token, data, notification = null) => {
  if (!admin.apps.length) {
    console.warn('[Firebase] Skipping push: Admin SDK not initialized');
    return null;
  }

  try {
    const message = {
      token,
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    if (notification) {
      message.notification = notification;
    }

    const response = await admin.messaging().send(message);
    console.log('[Firebase] Push sent successfully:', response);
    return response;
  } catch (error) {
    console.error('[Firebase] Error sending push notification:', error);
    return null;
  }
};

const sendCallNotification = async (receiver, caller, callData) => {
  if (!receiver.fcmToken) {
    console.warn(`[Firebase] Skipping push: No FCM token for user ${receiver._id}`);
    return null;
  }

  const data = {
    type: 'incoming_call',
    callerId: caller._id.toString(),
    callerName: caller.name,
    callerAvatar: caller.avatar || '',
    channelName: callData.channelName,
    callType: callData.type,
    chatId: callData.chatId || '',
  };

  const notification = {
    title: 'Incoming Call',
    body: `${caller.name} is calling you...`,
  };

  return sendPushNotification(receiver.fcmToken, data, notification);
};

module.exports = {
  sendPushNotification,
  sendCallNotification,
};
