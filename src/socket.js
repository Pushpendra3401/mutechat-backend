const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Message = require('./models/message.model');
const Chat = require('./models/chat.model');
const User = require('./models/user.model');
const Call = require('./models/call.model');
const { sendMessageNotification, sendCallNotification } = require('./services/notificationService');

class SocketManager {
  constructor(server) {
    this.io = new Server(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      // Keep-alive settings for production stability
      pingTimeout: 60000,
      pingInterval: 25000,
      // Horizontal Scaling Support (Production)
      // adapter: require('socket.io-redis')({ host: process.env.REDIS_HOST, port: 6379 })
    });

    this.onlineUsers = new Map(); // userId -> socketId
    this.reconnectTimeouts = new Map(); // userId -> timeoutId
  }

  init() {
    // 0. Middleware for Socket Authentication
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        
        if (!token) {
          console.warn(`[Socket Auth] Connection rejected: Token missing for socket ${socket.id}`);
          return next(new Error('Authentication error: Token missing'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('_id name');
        
        if (!user) {
          console.warn(`[Socket Auth] Connection rejected: User not found for token ${token.substring(0, 10)}...`);
          return next(new Error('Authentication error: User not found'));
        }

        socket.userId = user._id.toString();
        socket.user = user;
        next();
      } catch (err) {
        console.error('[Socket Auth] Error:', err.message);
        return next(new Error('Authentication error: Invalid token'));
      }
    });

    this.io.on('connection', (socket) => {
      const userId = socket.userId;
      console.log(`[Socket] Connected: ${socket.id} (User: ${userId}) | Transport: ${socket.conn.transport.name}`);

      // CLEAR ANY RECONNECT TIMEOUT (Grace Period)
      if (this.reconnectTimeouts.has(userId)) {
        console.log(`[Socket] Reconnect within grace period for user ${userId}. Cancelling cleanup.`);
        clearTimeout(this.reconnectTimeouts.get(userId));
        this.reconnectTimeouts.delete(userId);
      }
      
      // ENFORCE SINGLE SOCKET PER USER - SAFE REPLACEMENT
      const existingSocketId = this.onlineUsers.get(userId);
      if (existingSocketId && existingSocketId !== socket.id) {
        console.log(`[Socket] User ${userId} connected from new socket ${socket.id}. Replacing stale ${existingSocketId}`);
        const existingSocket = this.io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          // Send specific event so frontend knows it was replaced
          existingSocket.emit('force_disconnect', { 
            reason: 'session_replaced',
            message: 'You have been connected from another session.' 
          });
          existingSocket.disconnect(true);
        }
      }

      socket.join(userId);
      this.onlineUsers.set(userId, socket.id);
      
      // Notify client they are ready
      socket.emit('setup_complete', { userId, socketId: socket.id });
      
      // Update DB and broadcast status
      User.findByIdAndUpdate(userId, { 
        onlineStatus: true,
        lastSeen: Date.now() 
      }).then(async () => {
        this.io.emit('online_status', { userId, status: true });
        
        // Auto-deliver pending messages
        const result = await Message.updateMany(
          { receiver: userId, status: 'sent' },
          { status: 'delivered' }
        );
        
        if (result.modifiedCount > 0) {
          console.log(`[Socket] Auto-delivered ${result.modifiedCount} messages for ${userId}`);
          this.io.emit('messages_marked_delivered', { userId });
        }
      }).catch(err => console.error('[Socket] Status update error:', err));

      // 7. Disconnect Logic with Grace Period
      socket.on('disconnect', async (reason) => {
        console.log(`[Socket] Disconnected: ${socket.id} (User: ${userId}) | Reason: ${reason}`);
        
        // Only trigger cleanup if this was the ACTIVE socket
        if (this.onlineUsers.get(userId) === socket.id) {
          console.log(`[Socket] Starting 30s grace period for user ${userId} to reconnect...`);
          
          const timeoutId = setTimeout(async () => {
            // RE-VERIFY: If the user reconnected during the timeout, abort cleanup
            const currentSocketId = this.onlineUsers.get(userId);
            if (currentSocketId && currentSocketId !== socket.id) {
               console.log(`[Socket] Grace period aborted: User ${userId} reconnected with socket ${currentSocketId}`);
               return;
            }

            console.log(`[Socket] Grace period EXPIRED for user ${userId}. Marking offline.`);
            
            this.onlineUsers.delete(userId);
            this.reconnectTimeouts.delete(userId);
            
            await User.findByIdAndUpdate(userId, { 
              onlineStatus: false,
              lastSeen: Date.now() 
            });

            this.io.emit('online_status', { userId, status: false });

            // Atomic Call Cleanup ONLY after grace period expires
            const activeCall = await Call.findOne({
              $or: [{ caller: userId }, { receiver: userId }],
              status: { $in: ['initiated', 'ringing', 'accepted', 'ongoing'] }
            });

            if (activeCall) {
               console.log(`[Socket] Ending active call ${activeCall.channelName} due to persistent disconnect after 30s`);
               activeCall.status = 'ended';
               activeCall.endTime = Date.now();
               await activeCall.save();

               const otherUser = activeCall.caller.toString() === userId 
                 ? activeCall.receiver.toString() 
                 : activeCall.caller.toString();
               
               this.io.to(otherUser).emit('call_ended', { 
                 channelName: activeCall.channelName,
                 reason: 'peer_disconnected_timeout' 
               });
            }
          }, 30000); // Increased to 30s for better recovery on mobile

          this.reconnectTimeouts.set(userId, timeoutId);
        }
      });

      // Heartbeat Logging
      socket.conn.on('packet', (packet) => {
        if (packet.type === 'ping') console.log(`[Socket] PING from ${socket.id}`);
        if (packet.type === 'pong') console.log(`[Socket] PONG to ${socket.id}`);
      });

      // 2. Room Management
      socket.on('join_chat', (chatId) => {
        if (!chatId) return;
        socket.join(chatId);
        console.log(`[Socket] User ${socket.userId} joined room: ${chatId}`);
      });

      socket.on('leave_chat', (chatId) => {
        if (!chatId) return;
        socket.leave(chatId);
        console.log(`[Socket] User ${socket.userId} left room: ${chatId}`);
      });

      // 3. Send Message (with Acknowledgement)
      socket.on('send_message', async (data, callback) => {
        const { sender, receiver, text, media, replyTo, chatId, tempId, clientMessageId } = data;

        // Security: Ensure sender matches authenticated socket user
        if (sender !== socket.userId) {
          console.error(`[Socket] SECURITY ALERT: User ${socket.userId} tried to send message as ${sender}`);
          if (callback) callback({ status: 'error', message: 'Unauthorized sender' });
          return;
        }

        if (!sender || !receiver || !chatId) {
          console.error(`[Socket] ERROR: Missing data for message from ${socket.userId}. ChatId: ${chatId}`);
          if (callback) callback({ status: 'error', message: 'Missing data' });
          return;
        }

        console.log(`[Socket] MESSAGE_RECEIVED: From ${sender} to ${receiver} in chat ${chatId} | clientMessageId: ${clientMessageId || tempId}`);

        try {
          // Check for existing message with same clientMessageId to prevent duplicates
          if (clientMessageId) {
            const existing = await Message.findOne({ clientMessageId });
            if (existing) {
              console.log(`[Socket] DUPLICATE_PREVENTED: Message with clientMessageId ${clientMessageId} already exists`);
              const populated = await Message.findById(existing._id).populate('sender', 'name profilePicture avatar').populate('replyTo');
              if (callback) callback({ status: 'ok', message: populated, tempId: tempId });
              return;
            }
          }

          // Create Message
          const newMessage = await Message.create({
            sender,
            receiver,
            chat: chatId,
            text,
            media,
            replyTo,
            clientMessageId: clientMessageId || tempId,
            status: this.onlineUsers.has(receiver) ? 'delivered' : 'sent',
          });

          console.log(`[Socket] DB: Message created with ID ${newMessage._id}. Status: ${newMessage.status}`);

          // Update Chat
          const unreadKey = `unreadCount.${receiver}`;
          const chat = await Chat.findByIdAndUpdate(chatId, {
            lastMessage: newMessage._id,
            $inc: { [unreadKey]: 1 }
          }, { new: true });

          if (!chat) {
            console.error(`[Socket] ERROR: Chat ${chatId} not found during message update`);
            throw new Error('Chat not found');
          }

          // Populate for emission
          const messageToEmit = await Message.findById(newMessage._id)
            .populate('sender', 'name profilePicture avatar')
            .populate('replyTo');

          // Emit to the chat room
          console.log(`[Socket] EMIT: receive_message to room ${chatId}`);
          this.io.to(chatId).emit('receive_message', messageToEmit);

          // If delivered immediately, notify the sender specifically about delivery
          if (newMessage.status === 'delivered') {
            this.io.to(chatId).emit('messages_marked_delivered', { 
              chatId, 
              userId: receiver 
            });
          }
          
          // If receiver is NOT in the chat room room but is online, send to their personal room
          const receiverSocket = this.onlineUsers.get(receiver);
          if (receiverSocket) {
            const isReceiverInRoom = this.io.sockets.adapter.rooms.get(chatId)?.has(receiverSocket);
            if (!isReceiverInRoom) {
              console.log(`[Socket] EMIT: receive_message to receiver personal room ${receiver}`);
              this.io.to(receiver).emit('receive_message', messageToEmit);
            }
          }

          // Emit chat update for list synchronization
          const updatedChat = await Chat.findById(chatId)
            .populate('participants', 'name mobileNumber avatar onlineStatus lastSeen')
            .populate({
              path: 'lastMessage',
              populate: { path: 'sender', select: 'name' },
            });

          console.log(`[Socket] EMIT: chat_update to sender ${sender} and receiver ${receiver}`);
          this.io.to(sender).emit('chat_update', updatedChat);
          this.io.to(receiver).emit('chat_update', updatedChat);

          // PUSH NOTIFICATION: Send if receiver is not online or not in the room
          const isReceiverInRoom = receiverSocket ? this.io.sockets.adapter.rooms.get(chatId)?.has(receiverSocket) : false;
          
          if (!isReceiverInRoom) {
            try {
              const receiverUser = await User.findById(receiver).select('fcmToken');
              const senderUser = await User.findById(sender).select('name');
              
              if (receiverUser && receiverUser.fcmToken) {
                console.log(`[Socket] PUSH: Sending message notification to ${receiver}`);
                await sendMessageNotification(receiverUser.fcmToken, senderUser, {
                  chatId: chatId,
                  text: text,
                  media: media
                });
              }
            } catch (err) {
              console.error('[Socket] FCM ERROR in send_message:', err.message);
            }
          }

          // Acknowledge to sender
          if (callback) {
            callback({
              status: 'ok',
              message: messageToEmit,
              tempId: tempId
            });
          }

        } catch (error) {
          console.error('[Socket] FATAL ERROR in send_message:', error);
          if (callback) callback({ status: 'error', message: error.message });
        }
      });

      // 5. Message Seen
      socket.on('message_seen', async (data) => {
        const { chatId, userId } = data; 
        
        // Security: Ensure userId matches authenticated socket user
        if (userId !== socket.userId) return;

        try {
          if (!chatId || !userId) return;

          // Update messages in DB
          await Message.updateMany(
            { chat: chatId, receiver: userId, status: { $ne: 'seen' } },
            { status: 'seen' }
          );

          // Reset unread count
          const chat = await Chat.findById(chatId);
          if (chat) {
            chat.unreadCount.set(userId, 0);
            await chat.save();
            
            // Notify other participant(s)
            chat.participants.forEach(p => {
              if (p.toString() !== userId) {
                this.io.to(p.toString()).emit('messages_marked_seen', { chatId, userId });
              }
            });
          }
        } catch (error) {
          console.error('[Socket] message_seen error:', error);
        }
      });

      // 5.2 Typing status with room broadcast
      socket.on('typing', (data) => {
        const { chatId, receiverId } = data;
        if (!chatId) return;
        // Notify both specific receiver and the chat room
        socket.to(chatId).emit('typing', { chatId, senderId: socket.userId });
        if (receiverId) {
          this.io.to(receiverId).emit('typing', { chatId, senderId: socket.userId });
        }
      });

      socket.on('stop_typing', (data) => {
        const { chatId, receiverId } = data;
        if (!chatId) return;
        // Notify both specific receiver and the chat room
        socket.to(chatId).emit('stop_typing', { chatId, senderId: socket.userId });
        if (receiverId) {
          this.io.to(receiverId).emit('stop_typing', { chatId, senderId: socket.userId });
        }
      });

      // 5.1 Message Delivered (Explicit acknowledgment from device)
      socket.on('message_delivered', async (data) => {
        const { chatId, userId, messageId } = data;
        try {
          if (!chatId || !userId) return;

          const query = messageId ? { _id: messageId } : { chat: chatId, receiver: userId, status: 'sent' };
          
          await Message.updateMany(
            query,
            { status: 'delivered' }
          );

          this.io.to(chatId).emit('messages_marked_delivered', { chatId, userId });
          console.log(`[Socket] Explicit delivery ack for user ${userId} in chat ${chatId}`);
        } catch (error) {
          console.error('[Socket] message_delivered error:', error);
        }
      });

      // 6. Call signaling - FIXED: Changed from 'call_user' to 'initiate_call' to match frontend
      socket.on('initiate_call', async (data) => {
        const userId = socket.userId;
        
        // Security: Ensure caller matches authenticated socket user
        let currentCallerId;
        if (data.caller && typeof data.caller === 'object') {
          currentCallerId = data.caller.id || data.caller._id;
        } else {
          currentCallerId = data.callerId;
        }

        if (currentCallerId !== userId) {
          console.error(`[Socket] SECURITY ALERT: User ${userId} tried to initiate call as ${currentCallerId}`);
          return;
        }
        
        const channelName = data.channelId || data.channelName;
        console.log(`[Call] initiate_call: From ${userId} for channel ${channelName}`);
        
        // CHECK FOR ALREADY ACTIVE CALL TO PREVENT DUPLICATES
        const existingCall = await Call.findOne({
          channelName,
          status: { $in: ['initiated', 'ringing', 'accepted'] }
        });

        if (existingCall) {
          console.log(`[Call] DUPLICATE_PREVENTED: Call for channel ${channelName} is already active.`);
          return;
        }

        // Parse data - frontend sends CallModel.toJson() with caller/receiver objects
        let receiverId, type, chatId;
        
        if (data.caller && typeof data.caller === 'object') {
          receiverId = data.receiver.id || data.receiver._id;
          type = data.type;
          chatId = data.chatId;
        } else {
          receiverId = data.receiverId;
          type = data.type;
          chatId = data.chatId;
        }
        
        if (!userId || !receiverId || !channelName) {
          console.error('[CALL] Creation failed: Missing required data');
          return;
        }

        try {
          const [caller, receiver] = await Promise.all([
            User.findById(userId),
            User.findById(receiverId)
          ]);

          if (!caller || !receiver) {
            console.error('[CALL] User not found');
            this.io.to(userId).emit('call_error', { message: 'Receiver not found' });
            return;
          }

          // 1. Create and Save Call Record FIRST
          await Call.create({
            caller: userId,
            receiver: receiverId,
            type,
            channelName,
            status: 'initiated',
          });

          // 2. EMIT TO RECEIVER
          this.io.to(receiverId).emit('incoming_call', {
            callerId: userId,
            callerName: caller.name,
            callerAvatar: caller.avatar,
            type,
            channelName,
            chatId,
          });
          
          console.log(`[Socket] Incoming call event emitted to receiver ${receiverId}`);

          // 3. PUSH NOTIFICATION (FCM)
          if (receiver.fcmToken) {
            await sendCallNotification(receiver.fcmToken, caller, {
              channelName,
              chatId,
              type,
            });
          }

        } catch (error) {
          console.error('[CALL] FATAL ERROR in initiate_call:', error.message);
          this.io.to(userId).emit('call_error', { message: 'Failed to initiate call' });
        }
      });

      socket.on('call_ringing', async (data) => {
        const { callerId, channelName } = data;
        console.log(`[CALL] RINGING: Channel ${channelName} for caller ${callerId}`);
        
        try {
          await Call.findOneAndUpdate(
            { channelName, status: 'initiated' },
            { status: 'ringing' }
          );
          this.io.to(callerId).emit('call_ringing', { channelName });
        } catch (error) {
          console.error('[CALL] Ringing update error:', error.message);
        }
      });

      socket.on('call_busy', async (data) => {
        const { callerId, channelName } = data;
        try {
          await Call.findOneAndUpdate(
            { channelName, status: { $in: ['initiated', 'ringing'] } },
            { status: 'ended' }
          );
          this.io.to(callerId).emit('call_busy', { channelName });
        } catch (error) {
          console.error('[CALL] Busy update error:', error.message);
        }
      });

      // Realtime Call Captions
      socket.on('call_caption', (data) => {
        const { otherUserId, text, isFinal, channelName } = data;
        if (!channelName) return;
        
        // If otherUserId is not provided, we can broadcast to the room
        // For 1:1 calls, room is safer or direct emit
        if (otherUserId) {
          this.io.to(otherUserId).emit('call_caption', {
            text,
            isFinal,
            senderId: socket.userId,
            channelName
          });
        } else {
          socket.to(channelName).emit('call_caption', {
            text,
            isFinal,
            senderId: socket.userId,
            channelName
          });
        }
      });

      // Realtime Call TTS Messaging
      socket.on('call_tts_message', (data) => {
        const { otherUserId, text, channelName } = data;
        if (!channelName || !text) return;

        console.log(`[Call] TTS: From ${socket.userId} to ${otherUserId || channelName} | Msg: ${text.substring(0, 20)}...`);
        
        if (otherUserId) {
          this.io.to(otherUserId).emit('call_tts_message', {
            text,
            senderId: socket.userId,
            channelName
          });
        } else {
          socket.to(channelName).emit('call_tts_message', {
            text,
            senderId: socket.userId,
            channelName
          });
        }
      });

      // Call Reactions
      socket.on('call_reaction', (data) => {
        const { otherUserId, emoji, channelName } = data;
        if (!channelName) return;

        if (otherUserId) {
          this.io.to(otherUserId).emit('call_reaction', {
            emoji,
            senderId: socket.userId,
            channelName
          });
        } else {
          socket.to(channelName).emit('call_reaction', {
            emoji,
            senderId: socket.userId,
            channelName
          });
        }
      });

      socket.on('accept_call', async (data) => {
        const { channelName } = data;
        const receiverId = socket.userId;
        
        console.log(`[CALL_ACCEPT] start | Channel: ${channelName} | Receiver: ${receiverId}`);

        try {
          // Find the call session first to get the callerId
          const call = await Call.findOne({ channelName });
          if (!call) {
            console.error(`[CALL_ACCEPT] ERROR: Call session not found for channel: ${channelName}`);
            return;
          }

          const callerId = call.callerId.toString();
          console.log(`[CALL_ACCEPT] callerId: ${callerId}`);
          console.log(`[CALL_ACCEPT] receiverId: ${receiverId}`);

          call.status = 'accepted';
          call.startTime = Date.now();
          await call.save();
          console.log(`[CALL_ACCEPT] DB updated to accepted`);
          
          console.log(`[CALL_ACCEPT] emitting to caller: ${callerId}`);
          this.io.to(callerId).emit('call_accepted', { channelName });
        } catch (error) {
          console.error('[CALL_ACCEPT] ERROR:', error.message);
        }
      });

      socket.on('reject_call', async (data) => {
        const { channelName } = data;
        console.log(`[CALL_REJECT] start | Channel: ${channelName} | Receiver: ${socket.userId}`);
        
        try {
          const call = await Call.findOne({ channelName });
          if (!call) {
            console.error(`[CALL_REJECT] ERROR: Call session not found for channel: ${channelName}`);
            return;
          }

          const callerId = call.callerId.toString();
          console.log(`[CALL_REJECT] callerId: ${callerId}`);

          call.status = 'rejected';
          await call.save();
          console.log(`[CALL_REJECT] DB updated to rejected`);
          
          this.io.to(callerId).emit('call_rejected', { channelName });
          console.log(`[CALL_REJECT] emitted to caller: ${callerId}`);
        } catch (error) {
          console.error('[CALL_REJECT] ERROR:', error.message);
        }
      });

      socket.on('end_call', async (data) => {
        const { otherUserId, channelName } = data;
        const userId = socket.userId;

        console.log(`[Call] end_call request from ${userId} for channel: ${channelName}`);
        
        try {
          // 1. Check current call state
          const call = await Call.findOne({ channelName });
          
          if (!call) {
            console.warn(`[Call] end_call ignored: Channel ${channelName} not found.`);
            return;
          }

          if (call.status === 'ended') {
            console.log(`[Call] end_call ignored: Channel ${channelName} already ended.`);
            return;
          }

          // PROTECTION: Prevent end_call from cleaning up a call that was JUST accepted
          // If the call was accepted less than 2 seconds ago, it might be a race condition from UI disposal
          const timeSinceAccept = Date.now() - (call.startTime || 0);
          if (call.status === 'accepted' && timeSinceAccept < 2000) {
             console.warn(`[Call] RACE CONDITION DETECTED: Ignoring end_call received JUST after accept (${timeSinceAccept}ms)`);
             return;
          }

          console.log(`[Call] Ending channel: ${channelName} | Initiated by: ${userId}`);
          
          call.status = 'ended';
          call.endTime = Date.now();
          await call.save();
          
          console.log(`[Call] DB updated to ended for ${channelName}`);
          
          this.io.to(otherUserId).emit('call_ended', { channelName });
          console.log(`[Socket] call_ended emitted to ${otherUserId}`);
        } catch (error) {
          console.error('[CALL] End update error:', error.message);
        }
      });

      // 6.3 Status signaling
      socket.on('status_update', (data) => {
        // Broadcast new status to all online users or specifically to contacts
        // For simplicity in this MVP, broadcast to all
        socket.broadcast.emit('status_update', data);
      });
    });
  }
}

module.exports = SocketManager;
