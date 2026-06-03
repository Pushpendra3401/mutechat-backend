/**
 * Normalizes phone number to +91XXXXXXXXXX or standard E.164
 * @param {string} phone 
 * @returns {string}
 */
const normalizePhoneNumber = (phone) => {
  if (!phone) return phone;
  
  // Remove all non-digit characters
  let digits = phone.replace(/\D/g, '');
  
  // Handle 10-digit Indian numbers
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  
  // Handle 12-digit Indian numbers starting with 91
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }
  
  // For other lengths, if it doesn't have a +, add it (basic fallback)
  if (!phone.startsWith('+') && digits.length > 0) {
    return `+${digits}`;
  }
  
  return phone;
};

module.exports = {
  normalizePhoneNumber,
};
