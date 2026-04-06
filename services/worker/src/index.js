require('dotenv').config();
const { closeRedis } = require('./redis');
const { closeMongo } = require('./db');
const { startProcessing, stopProcessing } = require('./processor');

console.log('Starting PulseTrack Worker Service...');

// Kick off the infinite processing loop asynchronously
startProcessing().catch(err => {
  console.error('Fatal error starting worker:', err);
  process.exit(1);
});

// Graceful shutdown handling mapping Docker termination signals
const shutdown = async () => {
  console.log('\n[Worker] Graceful shutdown initiated...');

  // Instruct the while loop to stop spinning
  stopProcessing();

  // Give the processor 2 seconds to finish blocking on the current batch
  setTimeout(async () => {
    await closeMongo();
    await closeRedis();
    console.log('[Worker] Safely terminating process.');
    process.exit(0);
  }, 2000);
};

process.on('SIGINT', shutdown); // Ctrl+C natively
process.on('SIGTERM', shutdown); // Docker Stop natively

process.on('unhandledRejection', (err) => {
  console.error('[Worker] Unhandled Rejection:', err);
});
