// pm2 ecosystem for the pipeline.
// - Server: always 1 instance
// - Worker: 2 instances so two jobs can be processed concurrently.
//   The claimNextQueuedJob() logic ensures a worker only takes a job
//   that is still 'queued' and immediately marks it 'transcribing'
//   so the other worker won't pick the same job.
// Start: pm2 start ecosystem.config.js
// Logs: pm2 logs
// Restart worker only: pm2 restart pipeline-worker
module.exports = {
  apps: [
    {
      name: 'pipeline-server',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,   // currently used by live PM2 + videofurge nginx proxy
        // API_KEYS: 'secret-key-1,secret-key-2',
        // MAX_JOBS_PER_DAY: '3',
      },
      error_file: './logs/server-error.log',
      out_file: './logs/server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'pipeline-worker',
      script: 'worker.js',
      instances: 2,
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        // GROK_BIN: 'grok',
        // WHISPER_BIN: '/opt/whisper.cpp/main',
        // WHISPER_MODEL: '/opt/whisper.cpp/models/ggml-base.en.bin',
      },
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
