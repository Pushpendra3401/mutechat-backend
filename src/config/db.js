const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Drop unique email index if it exists to prevent E11000 duplicate key error on null emails
    try {
      const User = mongoose.model('User');
      await User.collection.dropIndex('email_1');
      console.log('Successfully dropped unique email index (email_1)');
    } catch (indexError) {
      // Index might not exist, which is fine
      if (indexError.code === 27) {
        console.log('Email index (email_1) does not exist, skipping drop.');
      } else {
        console.warn('Note: Could not drop email index:', indexError.message);
      }
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
