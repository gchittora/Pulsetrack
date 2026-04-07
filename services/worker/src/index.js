require('dotenv').config();
const { closeMongo } = require('./db');
const { startProcessing, stopProcessing } = require('./processor');

console.log('Starting PulseTrack Worker Service...');

startProcessing().catch(err => {
  console.error('[Worker] Fatal startup error:', err);
  process.exit(1);
});

const shutdown = async () => {
  console.log('\n[Worker] Graceful shutdown initiated...');

  stopProcessing();

  setTimeout(async () => {
    await closeMongo();
    process.exit(0);
  }, 2000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
