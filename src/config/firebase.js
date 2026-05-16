const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();

let messaging = null;

try {
  // Prevent duplicate initialization
  if (!admin.apps?.length) {
    console.log('[FCM] Checking Firebase environment variables...');
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY 
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
      : undefined;

    console.log('[FCM] Project ID exists:', !!projectId);
    console.log('[FCM] Client Email exists:', !!clientEmail);
    console.log('[FCM] Private Key exists:', !!privateKey);

    if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      console.log('[FCM] Firebase Admin initialized successfully via environment variables');
    } else {
      console.warn('[FCM] Firebase credentials missing in environment variables. Push notifications will be disabled.');
    }
  }

  if (admin.apps?.length) {
    messaging = admin.messaging();
    console.log('[FCM] Firebase messaging instance ready');
  }
} catch (error) {
  console.error('[FCM] Firebase Admin initialization error:', error);
}

module.exports = Object.freeze({
  admin,
  messaging,
});
