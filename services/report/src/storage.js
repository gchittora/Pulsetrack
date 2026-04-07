// ------------------------------------------------------------------
// MinIO Storage Client (using official MinIO SDK)
//
// WHY the MinIO SDK instead of @aws-sdk/client-s3?
//   The AWS SDK v3 (3.1000+) has issues with MinIO hostname resolution
//   in Docker networks. The MinIO SDK is purpose-built and handles
//   path-style requests, presigned URLs, and bucket ops natively.
//
//   In production with real S3, swap to @aws-sdk/client-s3.
//   The function signatures (uploadReport, getDownloadUrl) stay the same.
// ------------------------------------------------------------------

const Minio = require('minio');

const BUCKET = process.env.MINIO_BUCKET || 'reports';

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_HOST || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'pulse_admin',
  secretKey: process.env.MINIO_SECRET_KEY || 'pulse_secret_key',
});

async function ensureBucket() {
  const exists = await minioClient.bucketExists(BUCKET);
  if (!exists) {
    await minioClient.makeBucket(BUCKET, 'us-east-1');
    console.log(`[Report] Created MinIO bucket '${BUCKET}'`);
  } else {
    console.log(`[Report] MinIO bucket '${BUCKET}' exists`);
  }
}

async function uploadReport(key, buffer, contentType) {
  await minioClient.putObject(BUCKET, key, buffer, buffer.length, {
    'Content-Type': contentType,
  });
  console.log(`[Report] Uploaded: ${key} (${buffer.length} bytes)`);
  return key;
}

async function getDownloadUrl(key, expiresInSeconds = 3600) {
  const url = await minioClient.presignedGetObject(BUCKET, key, expiresInSeconds);
  
  // Replace internal docker network hostname with public localhost for downloading
  const internalHost = `http://${process.env.MINIO_HOST || 'localhost'}:${process.env.MINIO_PORT || '9000'}`;
  const externalHost = `http://${process.env.MINIO_EXTERNAL_HOST || 'localhost'}:${process.env.MINIO_EXTERNAL_PORT || '9000'}`;
  
  return url.replace(internalHost, externalHost);
}

module.exports = { ensureBucket, uploadReport, getDownloadUrl, BUCKET, minioClient };
