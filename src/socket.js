const { Server } = require('socket.io');
const Message = require('./models/message.model');
const Chat = require('./models/chat.model');
const User = require('./models/user.model');
const Call = require('./models/call.model');
const notificationService = require('./services/notificationService');

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
        socket.join(userId);
        this.onlineUsers.set(userId, socket.id);
        socket.userId = userId;
        console.log(`[Socket] User ${userId} joined their personal room (${socket.id})`);
        console.log(`[Socket] Current rooms for this socket:`, Array.from(socket.rooms));
        
        socket.emit('connected');
        
        // Mark user as online
        User.findByIdAndUpdate(userId, { 
          onlineStatus: true,
          lastSeen: Date.now() 
        }).then(() => {
          console.log(`[Socket] User ${userId} status updated to online`);
        }).catch(err => console.error('[Socket] Error updating user status:', err));

        this.io.emit('online_users', Array.from(this.onlineUsers.keys()));
      });

      // Legacy support for user_connected
      socket.on('user_connected', (userId) => {
        socket.emit('setup', userId);
      });

      // 2. Joining chat room
      socket.on('join_chat', (chatId) => {
        if (!chatId) return;
        socket.join(chatId);
        console.log(`[Socket] User ${socket.userId} joined chat room: ${chatId}`);
      });

      // 3. Send Message
      socket.on('send_message', async (data) => {
        const { sender, receiver, text, media, replyTo, chatId, tempId } = data;

        console.log(`[Socket] Message from ${sender} to ${receiver}: ${text || '[Media]'}`);

        try {
          // Find or Create Chat if not exists
          let chat;
          if (chatId && !chatId.startsWith('new_')) {
            chat = await Chat.findById(chatId);
          } else {
            chat = await Chat.findOne({
              participants: { $all: [sender, receiver] },
            });

            if (!chat) {
              chat = await Chat.create({
                participants: [sender, receiver],
              });
              console.log(`[Socket] New chat created: ${chat._id}`);
            }
          }

          if (!chat) {
            console.error('[Socket] Chat not found or could not be created');
            return;
          }

          // Create Message
          const newMessage = await Message.create({
            sender,
            receiver,
            chat: chat._id,
            text,
            media,
            replyTo,
            status: this.onlineUsers.has(receiver) ? 'delivered' : 'sent',
          });

          // Update Chat
          chat.lastMessage = newMessage._id;
          
          // Update unread count for receiver
          const currentCount = chat.unreadCount.get(receiver) || 0;
          chat.unreadCount.set(receiver, currentCount + 1);
          
          await chat.save();

          // Prepare message for emission
          const messageToEmit = await Message.findById(newMessage._id)
            .populate('sender', 'name profilePicture avatar')
            .populate('replyTo');

          // Emit to receiver's personal room (for instant delivery anywhere)
          console.log(`[Socket] Emitting receive_message to receiver: ${receiver}`);
          this.io.to(receiver).emit('receive_message', messageToEmit);
          
          // Emit back to sender with tempId for optimistic UI sync
          console.log(`[Socket] Emitting message_sent to sender: ${sender}`);
          this.io.to(sender).emit('message_sent', {
            message: messageToEmit,
            tempId: tempId
          });

          // Also emit to the specific chat room
          console.log(`[Socket] Emitting receive_message to chat room: ${chat._id}`);
          this.io.to(chat._id.toString()).emit('receive_message', messageToEmit);
          
          // Update chat list for both users
          const updatedChat = await Chat.findById(chat._id)
            .populate('participants', 'name mobileNumber avatar onlineStatus lastSeen')
            .populate({
              path: 'lastMessage',
              populate: { path: 'sender', select: 'name' },
            });

          this.io.to(sender).emit(`chat_update_${sender}`, updatedChat);
          this.io.to(receiver).emit(`chat_update_${receiver}`, updatedChat);

        } catch (error) {
          console.error('[Socket] Error in send_message:', error);
          socket.emit('message_error', { error: 'Failed to send message', tempId });
        }
      });

      // 4. Typing indicators
      socket.on('typing', (data) => {
        const { chatId, receiverId } = data;
        this.io.to(receiverId).emit('typing', { chatId, senderId: socket.userId });
      });

      socket.on('stop_typing', (data) => {
        const { chatId, receiverId } = data;
        this.io.to(receiverId).emit('stop_typing', { chatId, senderId: socket.userId });
      });

      // 5. Message Seen
      socket.on('message_seen', async (data) => {
        const { chatId, userId } = data; 
        
        try {
          if (!chatId || !userId) return;

          await Message.updateMany(
            { chat: chatId, receiver: userId, status: { $ne: 'seen' } },
            { status: 'seen' }
          );

          const chat = await Chat.findById(chatId);
          if (chat) {
            chat.unreadCount.set(userId, 0);
            await chat.save();
          }

          // Notify sender that messages were seen
          const otherParticipant = chat.participants.find(p => p.toString() !== userId);
          if (otherParticipant) {
            this.io.to(otherParticipant.toString()).emit('messages_marked_seen', { chatId, userId });
          }
        } catch (error) {
          console.error('[Socket] Error in message_seen:', error);
        }
      });

      // 6. Call signaling
      socket.on('call_user', async (data) => {
        const { callerId, receiverId, type, channelName, chatId } = data;
        console.log(`[Socket] Call from ${callerId} to ${receiverId} (${type}) on channel ${channelName}`);

        // 1. Get caller and receiver details
        const [caller, receiver] = await Promise.all([
          User.findById(callerId),
          User.findById(receiverId)
        ]);

        if (!caller || !receiver) {
          console.error('[Socket] Caller or Receiver not found');
          return;
        }

        // 2. Emit socket event for foreground users
        console.log(`[Socket] Emitting incoming_call to receiver room: ${receiverId}`);
        this.io.to(receiverId).emit('incoming_call', {
          callerId,
          callerName: caller.name,
          callerAvatar: caller.avatar,
          type,
          channelName,
          chatId,
        });

        // 3. Send Push Notification for background/killed users
        notificationService.sendCallNotification(receiver, caller, {
          type,
          channelName,
          chatId
        }).catch(err => console.error('[Socket] Error sending call push:', err));

        // 4. Create call record
        await Call.create({
          caller: callerId,
          receiver: receiverId,
          type,
          channelName,
          status: 'ongoing',
        }).catch(err => console.error('[Socket] Error creating call record:', err));
      });

      socket.on('accept_call', (data) => {
        const { callerId, channelName } = data;
        console.log(`[Socket] Call accepted by receiver for caller ${callerId}`);
        this.io.to(callerId).emit('call_accepted', { channelName });
      });

      socket.on('reject_call', (data) => {
        const { callerId } = data;
        console.log(`[Socket] Call rejected by receiver for caller ${callerId}`);
        this.io.to(callerId).emit('call_rejected');
      });

      socket.on('end_call', (data) => {
        const { otherUserId } = data;
        console.log(`[Socket] Call ended between users`);
        this.io.to(otherUserId).emit('call_ended');
      });

      // 7. Disconnect
      socket.on('disconnect', async () => {
        if (socket.userId) {
          this.onlineUsers.delete(socket.userId);
          await User.findByIdAndUpdate(socket.userId, { 
            onlineStatus: false,
            lastSeen: Date.now() 
          });
          this.io.emit('online_users', Array.from(this.onlineUsers.keys()));
        }
        console.log('User disconnected:', socket.id);
      });
    });
  }
}

module.exports = SocketManager;
