const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    let folder = 'mutechat/others';
    let resource_type = 'auto';

    if (file.mimetype.startsWith('image')) {
      folder = 'mutechat/images';
      resource_type = 'image';
    } else if (file.mimetype.startsWith('audio')) {
      folder = 'mutechat/voice_notes';
      resource_type = 'video'; // Cloudinary treats audio as video for resource_type
    } else if (file.mimetype.startsWith('video')) {
      folder = 'mutechat/videos';
      resource_type = 'video';
    }

    return {
      folder: folder,
      resource_type: resource_type,
      public_id: `${Date.now()}-${file.originalname.split('.')[0]}`,
    };
  },
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

module.exports = { upload, cloudinary };
