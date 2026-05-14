const { Server } = require('socket.io');
const Message = require('./models/message.model');
const Chat = require('./models/chat.model');
const User = require('./models/user.model');
const Call = require('./models/call.model');

class SocketManager {
  constructor(server) {
    this.io = new Server(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
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
        
        // Cleanup old room if any
        if (socket.userId && socket.userId !== userId) {
          socket.leave(socket.userId);
          this.onlineUsers.delete(socket.userId);
        }

        socket.join(userId);
        this.onlineUsers.set(userId, socket.id);
        socket.userId = userId;
        
        console.log(`[Socket] User ${userId} setup complete. Socket: ${socket.id}`);
        
        socket.emit('connected');
        
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
            // Notify senders? Usually, WhatsApp does this. 
            // For simplicity, we can let the next chat_update or a specific event handle it.
            // Let's emit a global event or just rely on the next interaction.
            // Actually, we should notify the senders.
            const sentMessages = await Message.find({ receiver: userId, status: 'delivered' }).distinct('chat');
            sentMessages.forEach(chatId => {
               this.io.to(chatId.toString()).emit('messages_marked_delivered', { chatId, userId });
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
        const { sender, receiver, text, media, replyTo, chatId, tempId } = data;

        if (!sender || !receiver || !chatId) {
          console.error(`[Socket] ERROR: Missing data for message from ${socket.userId}. ChatId: ${chatId}`);
          if (callback) callback({ status: 'error', message: 'Missing data' });
          return;
        }

        console.log(`[Socket] MESSAGE: From ${sender} to ${receiver} in chat ${chatId}. Text: ${text?.substring(0, 20)}...`);

        try {
          // Create Message
          const newMessage = await Message.create({
            sender,
            receiver,
            chat: chatId,
            text,
            media,
            replyTo,
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

      // 4. Typing indicators
      socket.on('typing', (data) => {
        const { chatId, receiverId } = data;
        if (!chatId || !receiverId) return;
        this.io.to(receiverId).emit('typing', { chatId, senderId: socket.userId });
      });

      socket.on('stop_typing', (data) => {
        const { chatId, receiverId } = data;
        if (!chatId || !receiverId) return;
        this.io.to(receiverId).emit('stop_typing', { chatId, senderId: socket.userId });
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

      // 6. Call signaling
      socket.on('call_user', async (data) => {
        const { callerId, receiverId, type, channelName, chatId } = data;
        
        if (!callerId || !receiverId || !channelName) {
          console.error('[CALL] Creation failed: Missing required data');
          return;
        }

        console.log(`[CALL] Initiating: From ${callerId} to ${receiverId} (${type}). Channel: ${channelName}`);

        try {
          const [caller, receiver] = await Promise.all([
            User.findById(callerId),
            User.findById(receiverId)
          ]);

          if (!caller || !receiver) {
            console.error('[CALL] User not found');
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

          // 2. Emit to receiver ONLY after record is saved
          console.log(`[CALL] Emitting incoming_call to receiver: ${receiverId}`);
          this.io.to(receiverId).emit('incoming_call', {
            callerId,
            callerName: caller.name,
            callerAvatar: caller.avatar,
            type,
            channelName,
            chatId,
          });

        } catch (error) {
          console.error('[CALL] FATAL ERROR in call_user:', error.message);
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
        
        console.log(`[CALL] ACCEPTED: By ${receiverId} for caller ${callerId}`);
        
        try {
          // Update call record to accepted
          await Call.findOneAndUpdate(
            { channelName, status: { $in: ['initiated', 'ringing'] } },
            { status: 'accepted', startTime: Date.now() }
          );

          // Notify caller
          this.io.to(callerId).emit('call_accepted', { 
            channelName,
            receiverId 
          });
        } catch (error) {
          console.error('[CALL] Accept update error:', error.message);
        }
      });

      socket.on('reject_call', async (data) => {
        const { callerId, channelName } = data;
        console.log(`[CALL] REJECTED: By ${socket.userId} for caller ${callerId}`);
        
        try {
          await Call.findOneAndUpdate(
            { channelName, status: { $in: ['initiated', 'ringing'] } },
            { status: 'rejected' }
          );
          this.io.to(callerId).emit('call_rejected', { channelName });
        } catch (error) {
          console.error('[CALL] Reject update error:', error.message);
        }
      });

      socket.on('end_call', async (data) => {
        const { otherUserId, channelName } = data;
        console.log(`[CALL] ENDED: Between ${socket.userId} and ${otherUserId}`);
        
        try {
          await Call.findOneAndUpdate(
            { channelName, status: { $ne: 'ended' } },
            { status: 'ended', endTime: Date.now() }
          );
          this.io.to(otherUserId).emit('call_ended', { channelName });
        } catch (error) {
          console.error('[CALL] End update error:', error.message);
        }
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
