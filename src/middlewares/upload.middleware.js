const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;

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

    if (file.mimetype.startsWith('image/')) {
      folder = 'mutechat/images';
      resource_type = 'image';
    } else if (file.mimetype.startsWith('video/')) {
      folder = 'mutechat/videos';
      resource_type = 'video';
    } else if (file.mimetype.startsWith('audio/')) {
      folder = 'mutechat/audio';
      resource_type = 'video'; // Cloudinary uses 'video' for audio files
    } else {
      folder = 'mutechat/files';
      resource_type = 'raw';
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
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max overall
  }
});

module.exports = upload;
