const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error('CRITICAL: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is missing in .env');
}

const client = twilio(accountSid, authToken);

/**
 * Validates Twilio configuration and lists available services
 */
exports.validateTwilioConfig = async () => {
  try {
    const serviceSid = process.env.TWILIO_SERVICE_SID;
    console.log('[Twilio] Auditing services for account:', accountSid);
    
    const services = await client.verify.v2.services.list();
    const availableServices = services.map(s => ({
      sid: s.sid,
      friendlyName: s.friendlyName
    }));

    console.log('Available Verify Services:', JSON.stringify(availableServices, null, 2));

    const exists = availableServices.find(s => s.sid === serviceSid);
    if (!exists) {
      const errorMsg = `❌ CRITICAL ERROR: Configured TWILIO_SERVICE_SID (${serviceSid}) does NOT exist in this Twilio account. Available SIDs: ${availableServices.map(s => s.sid).join(', ')}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    console.log(`✅ SUCCESS: TWILIO_SERVICE_SID (${serviceSid}) is valid and active.`);
    return true;
  } catch (error) {
    console.error('[Twilio] Validation Error:', error.message);
    throw error;
  }
};

/**
 * Send OTP using Twilio Verify Service
 * @param {string} mobileNumber 
 */
exports.sendOTP = async (mobileNumber) => {
  console.log('[Twilio] Sending OTP to:', mobileNumber);

  const response = await client.verify.v2
    .services(process.env.TWILIO_SERVICE_SID)
    .verifications
    .create({
      to: mobileNumber,
      channel: 'sms'
    });

  console.log('[Twilio] Send response:', response.status);

  return response;
};

/**
 * Verify OTP using Twilio Verify Service
 * @param {string} mobileNumber 
 * @param {string} otp 
 */
exports.verifyOTP = async (mobileNumber, otp) => {
  try {
    console.log(
      '[Twilio] Verifying OTP:',
      otp,
      'for',
      mobileNumber
    );

    const verificationCheck =
      await client.verify.v2
        .services(process.env.TWILIO_SERVICE_SID)
        .verificationChecks
        .create({
          to: mobileNumber,
          code: otp
        });

    console.log(
      '[Twilio] Verification result:',
      verificationCheck.status
    );

    return verificationCheck.status === 'approved';

  } catch (error) {
    console.error(
      '[Twilio Verify Error]',
      error.message
    );

    throw error;
  }
};
