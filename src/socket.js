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
          console.warn(`[SOCKET] Connection rejected: Token missing for socket ${socket.id}`);
          return next(new Error('Authentication error: Token missing'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('_id name');
        
        if (!user) {
          console.warn(`[SOCKET] Connection rejected: User not found for token ${token.substring(0, 10)}...`);
          return next(new Error('Authentication error: User not found'));
        }

        socket.userId = user._id.toString();
        socket.user = user;
        next();
      } catch (err) {
        console.error('[SOCKET] Auth Error:', err.message);
        return next(new Error('Authentication error: Invalid token'));
      }
    });

    this.io.on('connection', (socket) => {
      const userId = socket.userId;
      console.log(`[SOCKET] Connected: ${socket.id} (User: ${userId}) | Transport: ${socket.conn.transport.name}`);

      // CLEAR ANY RECONNECT TIMEOUT (Grace Period)
      if (this.reconnectTimeouts.has(userId)) {
        console.log(`[SOCKET] Reconnect within grace period for user ${userId}. Cancelling cleanup.`);
        clearTimeout(this.reconnectTimeouts.get(userId));
        this.reconnectTimeouts.delete(userId);
      }
      
      // ENFORCE SINGLE SOCKET PER USER - SAFE REPLACEMENT
      const existingSocketId = this.onlineUsers.get(userId);
      if (existingSocketId && existingSocketId !== socket.id) {
        console.log(`[SOCKET] User ${userId} connected from new socket ${socket.id}. Replacing stale ${existingSocketId}`);
        const existingSocket = this.io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          existingSocket.emit('force_disconnect', { 
            reason: 'session_replaced',
            message: 'You have been connected from another session.' 
          });
          existingSocket.disconnect(true);
        }
      }

      socket.join(userId);
      this.onlineUsers.set(userId, socket.id);
      
      socket.emit('setup_complete', { userId, socketId: socket.id });
      
      User.findByIdAndUpdate(userId, { 
        onlineStatus: true,
        lastSeen: Date.now() 
      }).then(async () => {
        this.io.emit('online_status', { userId, status: true });
        
        const result = await Message.updateMany(
          { receiver: userId, status: 'sent' },
          { status: 'delivered' }
        );
        
        if (result.modifiedCount > 0) {
          console.log(`[SOCKET] Auto-delivered ${result.modifiedCount} messages for ${userId}`);
          this.io.emit('messages_marked_delivered', { userId });
        }
      }).catch(err => console.error('[SOCKET] Status update error:', err));

      // 7. Disconnect Logic with Grace Period
      socket.on('disconnect', async (reason) => {
        console.log(`[SOCKET] Disconnected: ${socket.id} (User: ${userId}) | Reason: ${reason}`);
        
        if (this.onlineUsers.get(userId) === socket.id) {
          console.log(`[SOCKET] Starting 30s grace period for user ${userId} to reconnect...`);
          
          const timeoutId = setTimeout(async () => {
            const currentSocketId = this.onlineUsers.get(userId);
            if (currentSocketId && currentSocketId !== socket.id) {
               console.log(`[SOCKET] Grace period aborted: User ${userId} reconnected with socket ${currentSocketId}`);
               return;
            }

            console.log(`[SOCKET] Grace period EXPIRED for user ${userId}. Marking offline.`);
            
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
               console.log(`[CALL] Ending active call ${activeCall.channelName} due to persistent disconnect after 30s`);
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
          }, 30000);

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
        console.log(`[CHAT] User ${socket.userId} joined room: ${chatId}`);
      });

      socket.on('leave_chat', (chatId) => {
        if (!chatId) return;
        socket.leave(chatId);
        console.log(`[CHAT] User ${socket.userId} left room: ${chatId}`);
      });

      // 3. Send Message (with Acknowledgement)
      socket.on('send_message', async (data, callback) => {
        const { sender, receiver, text, media, replyTo, chatId, tempId, clientMessageId } = data;

        // Security: Ensure sender matches authenticated socket user
        if (sender !== socket.userId) {
          console.error(`[SOCKET] SECURITY ALERT: User ${socket.userId} tried to send message as ${sender}`);
          if (callback) callback({ status: 'error', message: 'Unauthorized sender' });
          return;
        }

        if (!sender || !receiver || !chatId) {
          console.error(`[CHAT] ERROR: Missing data for message from ${socket.userId}. ChatId: ${chatId}`);
          if (callback) callback({ status: 'error', message: 'Missing data' });
          return;
        }

        console.log(`[CHAT] Message from ${sender} to ${receiver} in chat ${chatId}`);

        try {
          // Check for existing message with same clientMessageId to prevent duplicates
          if (clientMessageId) {
            const existing = await Message.findOne({ clientMessageId });
            if (existing) {
              console.log(`[CHAT] Duplicate prevented: ${clientMessageId}`);
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

          console.log(`[CHAT] DB: Message created with ID ${newMessage._id}. Status: ${newMessage.status}`);

          // Update Chat
          const unreadKey = `unreadCount.${receiver}`;
          const chat = await Chat.findByIdAndUpdate(chatId, {
            lastMessage: newMessage._id,
            $inc: { [unreadKey]: 1 }
          }, { new: true });

          if (!chat) {
            console.error(`[CHAT] ERROR: Chat ${chatId} not found during message update`);
            throw new Error('Chat not found');
          }

          // Populate for emission
          const messageToEmit = await Message.findById(newMessage._id)
            .populate('sender', 'name profilePicture avatar')
            .populate('replyTo');

          // Emit to the chat room
          console.log(`[CHAT] EMIT: receive_message to room ${chatId}`);
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
              console.log(`[CHAT] EMIT: receive_message to receiver personal room ${receiver}`);
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

          console.log(`[CHAT] EMIT: chat_update to participants`);
          this.io.to(sender).emit('chat_update', updatedChat);
          this.io.to(receiver).emit('chat_update', updatedChat);

          // PUSH NOTIFICATION: Send if receiver is not online or not in the room
          const isReceiverInRoom = receiverSocket ? this.io.sockets.adapter.rooms.get(chatId)?.has(receiverSocket) : false;
          
          if (!isReceiverInRoom) {
            try {
              const receiverUser = await User.findById(receiver).select('fcmToken');
              const senderUser = await User.findById(sender).select('name');
              
              if (receiverUser && receiverUser.fcmToken) {
                console.log(`[FCM] PUSH: Sending message notification to ${receiver}`);
                await sendMessageNotification(receiverUser.fcmToken, senderUser, {
                  chatId: chatId,
                  text: text,
                  media: media
                });
              }
            } catch (err) {
              console.error('[FCM] ERROR in send_message:', err.message);
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

      // 4. Calling System
      socket.on('initiate_call', async (data) => {
        console.log('[CALL_FLOW] initiate_call received', JSON.stringify(data, null, 2));
        const { caller, receiver, channelName, type, chatId, startTime } = data;
        const callerId = caller._id || caller.id || socket.userId;
        const receiverId = receiver._id || receiver.id || receiver;
        
        console.log(`[CALL] INITIATE: ${callerId} -> ${receiverId} | Channel: ${channelName}`);
        
        try {
          const receiverUser = await User.findById(receiverId).select('fcmToken onlineStatus');
          if (!receiverUser) {
            console.error(`[CALL] ERROR: Receiver ${receiverId} not found`);
            return;
          }

          // [FIX 1] CREATE CALL DOCUMENT IN MONGODB!
          console.log('[CALL_FLOW] pending_call_created', { channelName, callerId, receiverId });
          const newCall = await Call.create({
            caller: callerId,
            receiver: receiverId,
            type: type || 'video',
            channelName: channelName,
            status: 'initiated',
            startTime: startTime ? new Date(startTime) : Date.now(),
            chatId: chatId
          });
          console.log('[CALL_FLOW] Call document saved to DB:', newCall._id);

          // Emit incoming_call to receiver
          const receiverSocketId = this.onlineUsers.get(receiverId.toString());
          if (receiverSocketId) {
            console.log('[CALL_FLOW] incoming_call_sent to', receiverSocketId);
            this.io.to(receiverSocketId).emit('incoming_call', data);
          } else {
            console.log(`[CALL] Receiver ${receiverId} is OFFLINE via socket`);
          }

          // Always send push notification for calls
          if (receiverUser.fcmToken) {
            const senderUser = await User.findById(callerId).select('name avatar');
            console.log(`[FCM] PUSH: Sending call notification to ${receiverId}`);
            await sendCallNotification(receiverUser.fcmToken, senderUser, data);
          }
        } catch (err) {
          console.error('[CALL] ERROR in initiate_call:', err);
        }
      });

      socket.on('call_ringing', (data) => {
        const { callerId, channelName } = data;
        console.log(`[CALL] RINGING: ${channelName} | To: ${callerId}`);
        this.io.to(callerId).emit('call_ringing', data);
      });

      socket.on('accept_call', async (data) => {
        console.log('[CALL_FLOW] accept_received', data);
        const { channelName } = data;
        console.log(`[CALL] ACCEPT: ${channelName} by ${socket.userId}`);
        
        try {
          const call = await Call.findOne({ channelName, status: { $in: ['initiated', 'ringing'] } });
          if (call) {
            console.log('[CALL_FLOW] pending_call_found', { channelName, callId: call._id });
            call.status = 'accepted';
            await call.save();
            
            const callerId = call.caller.toString();
            console.log('[CALL_FLOW] call_accepted_emitted to', callerId);
            this.io.to(callerId).emit('call_accepted', data);
          } else {
            console.warn(`[CALL] WARN: No pending call found for channel ${channelName} during accept`);
          }
        } catch (err) {
          console.error('[CALL] ERROR in accept_call:', err);
        }
      });

      socket.on('reject_call', async (data) => {
        const { channelName } = data;
        console.log(`[CALL] REJECT: ${channelName} by ${socket.userId}`);
        
        try {
          const call = await Call.findOne({ channelName, status: { $in: ['initiated', 'ringing'] } });
          if (call) {
            call.status = 'rejected';
            call.endTime = Date.now();
            await call.save();
            
            const callerId = call.caller.toString();
            console.log(`[CALL] EMIT: call_rejected to caller ${callerId}`);
            this.io.to(callerId).emit('call_rejected', data);
          }
        } catch (err) {
          console.error('[CALL] ERROR in reject_call:', err.message);
        }
      });

      socket.on('end_call', async (data) => {
        const { channelName, otherUserId } = data;
        console.log(`[CALL] END: ${channelName} by ${socket.userId}`);
        
        try {
          const call = await Call.findOne({ channelName });
          if (call && call.status !== 'ended') {
            call.status = 'ended';
            call.endTime = Date.now();
            await call.save();
          }
          
          if (otherUserId) {
            console.log(`[CALL] EMIT: call_ended to peer ${otherUserId}`);
            this.io.to(otherUserId).emit('call_ended', data);
          }
        } catch (err) {
          console.error('[CALL] ERROR in end_call:', err.message);
        }
      });

      socket.on('ping_call', async (data) => {
        const { channelName } = data;
        console.log(`[CALL] PING: ${channelName} from ${socket.userId}`);
        
        try {
          const call = await Call.findOne({ channelName });
          if (!call || call.status === 'ended') {
            console.log(`[CALL] PING_REPLY: Call ${channelName} is already ended. Notifying ${socket.userId}`);
            socket.emit('call_ended', { channelName, reason: 'sync_not_found' });
          } else {
            console.log(`[CALL] PING_REPLY: Call ${channelName} is still ${call.status}`);
          }
        } catch (err) {
          console.error('[CALL] ERROR in ping_call:', err.message);
        }
      });

      socket.on('call_busy', (data) => {
        const { callerId, channelName } = data;
        console.log(`[CALL] BUSY: ${channelName} | To: ${callerId}`);
        this.io.to(callerId).emit('call_busy', data);
      });

      socket.on('call_caption', (data) => {
        const { otherUserId, text, isFinal, channelName } = data;
        console.log(`[CHAT] CAPTION: ${channelName} | From: ${socket.userId}`);
        if (otherUserId) {
          this.io.to(otherUserId).emit('call_caption', {
            text,
            isFinal,
            senderId: socket.userId,
            channelName
          });
        }
      });

      socket.on('call_tts_message', (data) => {
        const { otherUserId, text, channelName } = data;
        console.log(`[CHAT] TTS: ${channelName} | From: ${socket.userId}`);
        if (otherUserId) {
          this.io.to(otherUserId).emit('call_tts_message', {
            text,
            senderId: socket.userId,
            channelName
          });
        }
      });

      socket.on('call_reaction', (data) => {
        const { otherUserId, emoji, channelName } = data;
        console.log(`[CHAT] REACTION: ${emoji} | From: ${socket.userId}`);
        if (otherUserId) {
          this.io.to(otherUserId).emit('call_reaction', {
            emoji,
            senderId: socket.userId,
            channelName
          });
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
