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

      // 1. User online status
      socket.on('user_connected', async (userId) => {
        if (!userId) return;
        this.onlineUsers.set(userId, socket.id);
        socket.userId = userId;
        
        await User.findByIdAndUpdate(userId, { 
          onlineStatus: true,
          lastSeen: Date.now() 
        });

        this.io.emit('online_users', Array.from(this.onlineUsers.keys()));
      });

      // 2. Joining chat room
      socket.on('join_chat', (chatId) => {
        socket.join(chatId);
        console.log(`User ${socket.userId} joined room: ${chatId}`);
      });

      // 3. Send Message
      socket.on('send_message', async (data) => {
        const { sender, receiver, text, media, replyTo, chatId } = data;

        try {
          // Find or Create Chat if not exists
          let chat;
          if (chatId) {
            chat = await Chat.findById(chatId);
          } else {
            chat = await Chat.findOne({
              participants: { $all: [sender, receiver] },
            });

            if (!chat) {
              chat = await Chat.create({
                participants: [sender, receiver],
              });
            }
          }

          if (!chat) return;

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

          // Emit to room
          const messageToEmit = await Message.findById(newMessage._id)
            .populate('sender', 'name profilePicture avatar')
            .populate('replyTo');

          this.io.to(chat._id.toString()).emit('receive_message', messageToEmit);
          
          // Also emit to chat list for both users to update last message
          this.io.emit(`chat_update_${sender}`, chat);
          this.io.emit(`chat_update_${receiver}`, chat);

        } catch (error) {
          console.error('Socket error (send_message):', error);
        }
      });

      // 4. Typing indicators
      socket.on('typing', (data) => {
        const { chatId, receiverId } = data;
        const receiverSocketId = this.onlineUsers.get(receiverId);
        if (receiverSocketId) {
          this.io.to(receiverSocketId).emit('typing', { chatId, senderId: socket.userId });
        }
      });

      socket.on('stop_typing', (data) => {
        const { chatId, receiverId } = data;
        const receiverSocketId = this.onlineUsers.get(receiverId);
        if (receiverSocketId) {
          this.io.to(receiverSocketId).emit('stop_typing', { chatId, senderId: socket.userId });
        }
      });

      // 5. Message Seen
      socket.on('message_seen', async (data) => {
        const { chatId, userId } = data; // userId is the one who saw the messages
        
        try {
          await Message.updateMany(
            { chat: chatId, receiver: userId, status: { $ne: 'seen' } },
            { status: 'seen' }
          );

          const chat = await Chat.findById(chatId);
          if (chat) {
            chat.unreadCount.set(userId, 0);
            await chat.save();
          }

          socket.to(chatId).emit('messages_marked_seen', { chatId, userId });
        } catch (error) {
          console.error('Socket error (message_seen):', error);
        }
      });

      // 6. Call signaling
      socket.on('call_user', async (data) => {
        const { callerId, receiverId, type, channelName } = data;
        const receiverSocketId = this.onlineUsers.get(receiverId);

        if (receiverSocketId) {
          this.io.to(receiverSocketId).emit('incoming_call', {
            callerId,
            type,
            channelName,
          });

          await Call.create({
            caller: callerId,
            receiver: receiverId,
            type,
            channelName,
            status: 'ongoing',
          });
        }
      });

      socket.on('accept_call', (data) => {
        const { callerId, channelName } = data;
        const callerSocketId = this.onlineUsers.get(callerId);
        if (callerSocketId) {
          this.io.to(callerSocketId).emit('call_accepted', { channelName });
        }
      });

      socket.on('reject_call', (data) => {
        const { callerId } = data;
        const callerSocketId = this.onlineUsers.get(callerId);
        if (callerSocketId) {
          this.io.to(callerSocketId).emit('call_rejected');
        }
      });

      socket.on('end_call', (data) => {
        const { otherUserId } = data;
        const otherSocketId = this.onlineUsers.get(otherUserId);
        if (otherSocketId) {
          this.io.to(otherSocketId).emit('call_ended');
        }
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
