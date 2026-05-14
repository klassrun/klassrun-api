// src/lib/cloudinary.js
// batch-2b-cloudinary-lib
//
// Cloudinary signing helper. Browser uploads files directly to Cloudinary
// using a signature we generate here, so file bytes never touch our API.

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function isConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET &&
    process.env.CLOUDINARY_UPLOAD_PRESET
  );
}

function generateLogoUploadSignature({ schoolId }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId  = `school-${schoolId}-${timestamp}`;
  const folder    = 'klassrun-school-logos';
  const preset    = process.env.CLOUDINARY_UPLOAD_PRESET;

  // Cloudinary signs the SHA1 of (alpha-sorted "k=v&" joined params) + API_SECRET.
  // Do NOT include api_key, cloud_name, file, or resource_type here.
  const paramsToSign = {
    folder,
    public_id: publicId,
    timestamp,
    upload_preset: preset,
  };

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    process.env.CLOUDINARY_API_SECRET
  );

  return {
    signature,
    timestamp,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey:    process.env.CLOUDINARY_API_KEY,
    preset,
    folder,
    publicId,
  };
}

module.exports = {
  isConfigured,
  generateLogoUploadSignature,
};
