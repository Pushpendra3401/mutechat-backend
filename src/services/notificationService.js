// Firebase integration is temporarily disabled.
// This file is kept as a placeholder to prevent import errors if any.

const sendPushNotification = async (token, data, notification = null) => {
  console.log('[NotificationService] Push notifications are currently disabled.');
  return null;
};

const sendCallNotification = async (receiver, caller, callData) => {
  console.log('[NotificationService] Call notifications are currently disabled.');
  return null;
};

module.exports = {
  sendPushNotification,
  sendCallNotification,
};
