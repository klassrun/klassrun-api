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

// ops-1-cloudinary — student passport photo signed upload (browser → Cloudinary)
function generateStudentPhotoUploadSignature({ schoolId, studentId }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sid = studentId || 'new';
  const publicId = `student-${schoolId}-${sid}-${timestamp}`;
  const folder = 'klassrun-student-photos';
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  const paramsToSign = { folder, public_id: publicId, timestamp, upload_preset: preset };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
  return {
    signature, timestamp,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    preset, folder, publicId,
  };
}

// ops-1-cloudinary — server-side PDF (report card) upload from a Buffer
function uploadPdfBuffer(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: 'klassrun-report-cards', public_id: publicId, overwrite: true, format: 'pdf' },
      (error, result) => {
        if (error) return reject(error);
        if (!result || !result.secure_url) return reject(new Error('No secure_url from Cloudinary'));
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// batch-4-scheme-upload-signature — signed RAW upload for PDF/DOCX scheme files.
// Mirrors generateStudentPhotoUploadSignature, but the client posts to
// /raw/upload (resourceType:'raw' flows that decision to the client). Reads the
// single CLOUDINARY_UPLOAD_PRESET; the per-call folder overrides the preset's.
function generateSchemeUploadSignature({ schoolId, classId, subjectId }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const cid = classId || 'cls';
  const sid = subjectId || 'subj';
  const publicId = `scheme-${schoolId}-${cid}-${sid}-${timestamp}`;
  const folder = 'klassrun-schemes';
  const preset = process.env.CLOUDINARY_RAW_PRESET || process.env.CLOUDINARY_UPLOAD_PRESET;
  const paramsToSign = { folder, public_id: publicId, timestamp, upload_preset: preset };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
  return {
    signature, timestamp,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    preset, folder, publicId,
    resourceType: 'raw',
  };
}

module.exports = {
  isConfigured,
  generateLogoUploadSignature,
  generateStudentPhotoUploadSignature,
  generateSchemeUploadSignature,
  uploadPdfBuffer,
};
