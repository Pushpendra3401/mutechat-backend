const { Server } = require('socket.io');
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
      // Horizontal Scaling Support (Production)
      // adapter: require('socket.io-redis')({ host: process.env.REDIS_HOST, port: 6379 })
    });

    this.onlineUsers = new Map(); // userId -> socketId
  }

  init() {
    this.io.on('connection', (socket) => {
      console.log('User connected:', socket.id);

      // 1. User Setup & Room
      socket.on('setup', (userId) => {
        if (!userId) {
          console.error('[Socket] Setup failed: No userId provided');
          return;
        }
        
        // ENFORCE SINGLE SOCKET PER USER
        const existingSocketId = this.onlineUsers.get(userId);
        if (existingSocketId && existingSocketId !== socket.id) {
          console.log(`[Socket] Replacing stale socket ${existingSocketId} for user ${userId}`);
          const existingSocket = this.io.sockets.sockets.get(existingSocketId);
          if (existingSocket) {
            existingSocket.emit('force_disconnect', { reason: 'Logged in from another device' });
            existingSocket.disconnect(true);
          }
        }

        socket.join(userId);
        this.onlineUsers.set(userId, socket.id);
        socket.userId = userId;
        
        console.log(`[Socket] USER_CONNECTED: ${userId} | Socket: ${socket.id}`);
        
        socket.emit('connected', { socketId: socket.id });
        
        // Mark user as online
        User.findByIdAndUpdate(userId, { 
          onlineStatus: true,
          lastSeen: Date.now() 
        }).then(async () => {
          this.io.emit('online_status', { userId, status: true });
          
          // Mark pending messages as delivered
          const result = await Message.updateMany(
            { receiver: userId, status: 'sent' },
            { status: 'delivered' }
          );
          
          if (result.modifiedCount > 0) {
            console.log(`[Socket] Marked ${result.modifiedCount} messages as delivered for ${userId}`);
            
            // Find chats where messages were delivered to notify senders
            const chatsWithDeliveredMessages = await Message.find({ 
              receiver: userId, 
              status: 'delivered' 
            }).distinct('chat');

            chatsWithDeliveredMessages.forEach(chatId => {
              // Emit to the chat room so the sender(s) get the update
              this.io.to(chatId.toString()).emit('messages_marked_delivered', { 
                chatId: chatId.toString(), 
                userId 
              });
            });
          }
        }).catch(err => console.error('[Socket] Status update error:', err));

        this.io.emit('online_users', Array.from(this.onlineUsers.keys()));
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
          const chat = await Chat.findByIdAndUpdate(chatId, {
            lastMessage: newMessage._id,
            $inc: { [`unreadCount.${receiver}`]: 1 }
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
          this.io.to(sender).emit(`chat_update_${sender}`, updatedChat);
          this.io.to(receiver).emit(`chat_update_${receiver}`, updatedChat);

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
        // TASK 3 - SOCKET EMIT: Backend receives outgoing call event
        console.log('[Socket] Incoming call event received on backend');
        console.log('[Call] Raw data received:', JSON.stringify(data));
        
        // Parse data - frontend sends CallModel.toJson() with caller/receiver objects
        let callerId, receiverId, type, channelName, chatId;
        
        if (data.caller && typeof data.caller === 'object') {
          // Frontend sends full CallModel with user objects
          callerId = data.caller.id || data.caller._id;
          receiverId = data.receiver.id || data.receiver._id;
          type = data.type;
          channelName = data.channelId;
          chatId = data.chatId;
          console.log('[Call] Parsed from CallModel structure');
        } else {
          // Fallback for backward compatibility
          callerId = data.callerId;
          receiverId = data.receiverId;
          type = data.type;
          channelName = data.channelName;
          chatId = data.chatId;
          console.log('[Call] Parsed from flat structure');
        }
        
        console.log('[Call] Caller ID:', callerId);
        console.log('[Call] Receiver ID:', receiverId);
        console.log('[Call] Channel ID:', channelName);
        console.log('[Call] Call Type:', type);
        
        if (!callerId || !receiverId || !channelName) {
          console.error('[CALL] Creation failed: Missing required data');
          console.error('[CALL] callerId:', callerId, 'receiverId:', receiverId, 'channelName:', channelName);
          return;
        }

        console.log(`[CALL] Call event received: From ${callerId} to ${receiverId} (${type}). Channel: ${channelName}`);

        try {
          const [caller, receiver] = await Promise.all([
            User.findById(callerId),
            User.findById(receiverId)
          ]);

          if (!caller || !receiver) {
            console.error('[CALL] User not found - caller:', !!caller, 'receiver:', !!receiver);
            this.io.to(callerId).emit('call_error', { message: 'Receiver not found' });
            return;
          }

          // 1. Create and Save Call Record FIRST
          console.log('[CALL] Creating call record in DB...');
          const callRecord = await Call.create({
            caller: callerId,
            receiver: receiverId,
            type,
            channelName,
            status: 'initiated', // Standardized state
          });
          console.log(`[CALL] Call record saved successfully: ${callRecord._id}`);

          // TASK 5 - RECEIVER DELIVERY: Verify backend emits to receiver
          // TASK 4 - SOCKET EMIT: Emitting incoming call to receiver
          console.log(`[Socket] Emitting incoming call to receiver`);
          console.log('[Socket] Receiver Socket ID:', receiverId);
          
          this.io.to(receiverId).emit('incoming_call', {
            callerId,
            callerName: caller.name,
            callerAvatar: caller.avatar,
            type,
            channelName,
            chatId,
          });
          
          console.log(`[Socket] Incoming call event emitted to receiver ${receiverId} | Channel: ${channelName}`);

          // PUSH NOTIFICATION: Send call push notification
          if (receiver.fcmToken) {
            console.log(`[Socket] PUSH: Sending call notification to ${receiverId}`);
            await sendCallNotification(receiver.fcmToken, caller, {
              channelName,
              chatId,
            });
          } else {
            console.log(`[Socket] PUSH: No FCM token for receiver ${receiverId}`);
          }

        } catch (error) {
          console.error('[CALL] FATAL ERROR in initiate_call:', error.message);
          console.error('[CALL] Stack:', error.stack);
          // If creation fails, notify caller
          this.io.to(callerId).emit('call_error', { message: 'Failed to initiate call' });
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
        console.log(`[CALL] BUSY: Channel ${channelName} for caller ${callerId}`);
        
        try {
          await Call.findOneAndUpdate(
            { channelName, status: 'initiated' },
            { status: 'busy' }
          );
          this.io.to(callerId).emit('call_busy', { channelName });
        } catch (error) {
          console.error('[CALL] Busy update error:', error.message);
        }
      });

      socket.on('accept_call', async (data) => {
        const { callerId, channelName } = data;
        const receiverId = socket.userId;
        
        console.log(`[Call] Call accepted`);
        console.log(`[Call] Channel: ${channelName}`);
        console.log(`[Call] Accepted by receiver: ${receiverId}`);
        console.log(`[Call] For caller: ${callerId}`);

        try {
          await Call.findOneAndUpdate(
            { channelName },
            { status: 'accepted', startTime: Date.now() }
          );
          console.log(`[Call] Call record updated to accepted status`);
          
          this.io.to(callerId).emit('call_accepted', { channelName });
          console.log(`[Socket] Call accepted event emitted to caller ${callerId}`);
        } catch (error) {
          console.error('[CALL] Accept update error:', error.message);
        }
      });

      // 6.1 Call Reactions
      socket.on('call_reaction', (data) => {
        const { channelName, emoji, senderId } = data;
        console.log(`[CALL] REACTION: ${emoji} in ${channelName} from ${senderId}`);
        // Broadcast to everyone in the call room except sender
        socket.to(channelName).emit('call_reaction', { emoji, senderId });
      });

      // 6.2 Call Captions
      socket.on('call_caption', (data) => {
        const { channelName, text, senderId, isFinal } = data;
        console.log(`[CALL] CAPTION: ${text} in ${channelName} from ${senderId}`);
        socket.to(channelName).emit('call_caption', { text, senderId, isFinal });
      });

      socket.on('reject_call', async (data) => {
        const { callerId, channelName } = data;
        console.log(`[Call] Call rejected`);
        console.log(`[Call] Channel: ${channelName}`);
        console.log(`[Call] Rejected by receiver: ${socket.userId}`);
        console.log(`[Call] For caller: ${callerId}`);
        
        try {
          await Call.findOneAndUpdate(
            { channelName, status: { $in: ['initiated', 'ringing'] } },
            { status: 'rejected' }
          );
          console.log(`[Call] Call record updated to rejected status`);
          
          this.io.to(callerId).emit('call_rejected', { channelName });
          console.log(`[Socket] Call rejected event emitted to caller ${callerId}`);
        } catch (error) {
          console.error('[CALL] Reject update error:', error.message);
        }
      });

      socket.on('end_call', async (data) => {
        const { otherUserId, channelName } = data;
        console.log(`[Call] Call ended`);
        console.log(`[Call] Channel: ${channelName}`);
        console.log(`[Call] Ended by: ${socket.userId}`);
        console.log(`[Call] Notifying other user: ${otherUserId}`);
        
        try {
          await Call.findOneAndUpdate(
            { channelName, status: { $ne: 'ended' } },
            { status: 'ended', endTime: Date.now() }
          );
          console.log(`[Call] Call record updated to ended status`);
          
          this.io.to(otherUserId).emit('call_ended', { channelName });
          console.log(`[Socket] Call ended event emitted to user ${otherUserId}`);
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

      // 7. Disconnect
      socket.on('disconnect', async () => {
        if (socket.userId) {
          console.log(`[Socket] User ${socket.userId} disconnected`);
          this.onlineUsers.delete(socket.userId);
          
          await User.findByIdAndUpdate(socket.userId, { 
            onlineStatus: false,
            lastSeen: Date.now() 
          });

          this.io.emit('online_status', { userId: socket.userId, status: false });
          this.io.emit('online_users', Array.from(this.onlineUsers.keys()));
        }
      });
    });
  }
}

module.exports = SocketManager;
