require('dotenv').config();
const http = require('http');
const app = require('./app');
const SocketManager = require('./socket');
const twilioService = require('./services/twilioService');

const validateEnv = () => {
  const required = [
    'TWILIO_ACCOUNT_SID', 
    'TWILIO_AUTH_TOKEN', 
    'TWILIO_SERVICE_SID',
    'MONGODB_URI',
    'JWT_SECRET',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'AGORA_APP_ID',
    'AGORA_APP_CERTIFICATE'
  ];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`❌ CRITICAL: Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('✅ All Environment variables validated');
};

const connectDB = async (retryCount = 5) => {
  const mongoose = require('mongoose');
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    if (retryCount > 0) {
      console.log(`Retrying connection in 5 seconds... (${retryCount} retries left)`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      return connectDB(retryCount - 1);
    }
    process.exit(1);
  }
};

// Start Server
const startServer = async () => {
  // 0. Graceful Shutdown
  const gracefulShutdown = (server) => {
    console.log('Shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  };

  // 0. Validate Environment Variables
  validateEnv();

  // 1. Connect to Database
  await connectDB();

  // 2. Validate Twilio Configuration
  try {
    await twilioService.validateTwilioConfig();
  } catch (error) {
    console.warn('⚠️ Twilio validation failed, but server will continue:', error.message);
  }

  // 3. Create HTTP Server
  const server = http.createServer(app);

  // 4. Initialize Socket.IO
  const socketManager = new SocketManager(server);
  socketManager.init();

  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    console.log(`
      🚀 MuteChat Backend running in ${process.env.NODE_ENV || 'development'} mode
      🔗 Port: ${PORT}
      ⚡ Socket.IO initialized
    `);
  });

  // Handle Errors
  process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
    console.error(err.name, err.message, err.stack);
    process.exit(1);
  });

  process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION! 💥 Shutting down...');
    console.error(err.name, err.message);
    server.close(() => {
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => gracefulShutdown(server));
  process.on('SIGINT', () => gracefulShutdown(server));
};

startServer();
