// ------------------------------------------------------------------
// Report API Routes
//
// POST /reports       — Request a new report (queues a BullMQ job)
// GET  /reports/:id   — Check job status + get download URL
// GET  /reports       — List all reports for the user
//
// This demonstrates the async request pattern:
//   1. Client POSTs to create a report → gets job ID immediately
//   2. Client polls GET /reports/:id until status is "completed"
//   3. Response includes a presigned MinIO URL for download
//
// WHY not just return the file in the POST response?
//   Because report generation takes 5-30 seconds (query MongoDB,
//   format data, upload to MinIO). HTTP requests shouldn't block
//   that long — it causes timeouts and poor UX.
// ------------------------------------------------------------------

const express = require('express');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const router = express.Router();

const QUEUE_NAME = 'report-jobs';

const connection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
});

const reportQueue = new Queue(QUEUE_NAME, { connection });

// POST /reports — Request a new report
router.post('/', async (req, res) => {
  try {
    const { project_id, format = 'csv', start_date, end_date } = req.body;

    if (!project_id) {
      return res.status(400).json({ error: 'project_id is required' });
    }

    if (!['csv', 'pdf'].includes(format)) {
      return res.status(400).json({ error: 'format must be csv or pdf' });
    }

    // Add job to BullMQ queue
    const job = await reportQueue.add('generate-report', {
      projectId: project_id,
      format,
      startDate: start_date || null,
      endDate: end_date || null,
      requestedBy: req.user?.email || 'unknown',
    }, {
      attempts: 3,          // Retry up to 3 times on failure
      backoff: {
        type: 'exponential',
        delay: 2000,         // 2s, 4s, 8s between retries
      },
    });

    res.status(202).json({
      message: 'Report queued for generation',
      job_id: job.id,
      status: 'queued',
      format,
      project_id,
    });

  } catch (err) {
    console.error('[Report API] Error queuing report:', err.message);
    res.status(500).json({ error: 'Failed to queue report' });
  }
});

// GET /reports/:id — Check report status
router.get('/:id', async (req, res) => {
  try {
    const job = await reportQueue.getJob(req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'Report job not found' });
    }

    const state = await job.getState();
    const progress = job.progress;

    const response = {
      job_id: job.id,
      status: state,
      progress,
      format: job.data.format,
      project_id: job.data.projectId,
      created_at: new Date(job.timestamp).toISOString(),
    };

    // If completed, include download URL
    if (state === 'completed' && job.returnvalue) {
      response.result = job.returnvalue;
    }

    // If failed, include error info
    if (state === 'failed') {
      response.error = job.failedReason;
    }

    res.json(response);

  } catch (err) {
    console.error('[Report API] Error checking status:', err.message);
    res.status(500).json({ error: 'Failed to check report status' });
  }
});

// GET /reports — List recent reports
router.get('/', async (req, res) => {
  try {
    const completed = await reportQueue.getCompleted(0, 20);
    const active = await reportQueue.getActive();
    const waiting = await reportQueue.getWaiting();
    const failed = await reportQueue.getFailed(0, 5);

    const formatJob = (job, status) => ({
      job_id: job.id,
      status,
      format: job.data.format,
      project_id: job.data.projectId,
      created_at: new Date(job.timestamp).toISOString(),
      result: job.returnvalue || null,
    });

    const reports = [
      ...active.map(j => formatJob(j, 'active')),
      ...waiting.map(j => formatJob(j, 'waiting')),
      ...completed.map(j => formatJob(j, 'completed')),
      ...failed.map(j => formatJob(j, 'failed')),
    ];

    res.json({ reports, total: reports.length });

  } catch (err) {
    console.error('[Report API] Error listing reports:', err.message);
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

module.exports = router;
