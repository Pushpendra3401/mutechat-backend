const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

/**
 * Generate Agora RTC Token
 * @param {string} channelName 
 * @param {number} uid 
 * @param {string} role - publisher or subscriber
 * @returns {string} token
 */
exports.generateToken = (channelName, uid, role = 'publisher') => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  
  console.log(`[AgoraService] Generating token for channel: ${channelName}, uid: ${uid}`);
  console.log(`[AgoraService] App ID: ${appId ? 'Configured' : 'MISSING'}`);
  console.log(`[AgoraService] App Certificate: ${appCertificate ? 'Configured' : 'MISSING'}`);

  if (!appId || !appCertificate) {
    throw new Error('Agora credentials are missing');
  }

  const agoraRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expirationTimeInSeconds = 3600; // 1 hour
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    agoraRole,
    privilegeExpiredTs
  );

  console.log(`[AgoraService] Token generated successfully (length: ${token.length})`);
  return token;
};
