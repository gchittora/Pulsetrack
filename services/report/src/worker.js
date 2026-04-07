// ------------------------------------------------------------------
// Report Job Worker (BullMQ)
//
// WHY a job queue instead of generating reports synchronously?
//   Reports scan thousands of MongoDB documents, generate files,
//   and upload to MinIO — this can take 5-30 seconds.
//   If we did this in the API request handler:
//   1. The HTTP request would timeout
//   2. The server thread is blocked, can't serve other requests
//   3. If the server crashes mid-generation, the work is lost
//
//   With BullMQ:
//   1. API accepts the request instantly (returns job ID)
//   2. Worker processes the job in the background
//   3. If the worker crashes, BullMQ automatically retries
//   4. Multiple workers can process jobs in parallel
//
// FLOW:
//   POST /reports → BullMQ queue → Worker picks up job →
//   Query MongoDB → Generate CSV/PDF → Upload to MinIO →
//   Store download URL → User polls GET /reports/:id for status
// ------------------------------------------------------------------

const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { connectMongo } = require('./db');
const { generateCSV, generatePDF } = require('./generator');
const { uploadReport, getDownloadUrl } = require('./storage');
const { v4: uuid } = require('uuid');

const QUEUE_NAME = 'report-jobs';

const connection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null, // Required by BullMQ
});

async function startWorker() {
  await connectMongo();

  const worker = new Worker(QUEUE_NAME, async (job) => {
    const { projectId, format, startDate, endDate } = job.data;
    console.log(`[Report Worker] Processing job ${job.id}: ${format} report for project ${projectId}`);

    await job.updateProgress(10);

    // Step 1: Generate the report
    let buffer, contentType, extension;
    if (format === 'pdf') {
      buffer = await generatePDF(projectId, startDate, endDate);
      contentType = 'application/pdf';
      extension = 'pdf';
    } else {
      buffer = await generateCSV(projectId, startDate, endDate);
      contentType = 'text/csv';
      extension = 'csv';
    }

    await job.updateProgress(60);

    // Step 2: Upload to MinIO
    const fileName = `project-${projectId}/${uuid()}.${extension}`;
    await uploadReport(fileName, buffer, contentType);

    await job.updateProgress(90);

    // Step 3: Generate a presigned download URL (valid for 1 hour)
    const downloadUrl = await getDownloadUrl(fileName, 3600);

    await job.updateProgress(100);

    console.log(`[Report Worker] Job ${job.id} complete: ${fileName}`);

    return {
      fileName,
      downloadUrl,
      format,
      size: buffer.length,
      generatedAt: new Date().toISOString(),
    };
  }, {
    connection,
    concurrency: 2, // Process 2 reports simultaneously
  });

  worker.on('completed', (job, result) => {
    console.log(`[Report Worker] Job ${job.id} completed: ${result.fileName}`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[Report Worker] Job ${job.id} failed: ${error.message}`);
  });

  console.log('[Report Worker] Ready and waiting for jobs...');
  return worker;
}

module.exports = { startWorker };
