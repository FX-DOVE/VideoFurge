// pm2 ecosystem for the pipeline (single VPS, one-job-at-a-time design).
// Start: pm2 start ecosystem.config.js
// Logs: pm2 logs
// Restart worker only: pm2 restart worker
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
        PORT: 3000,
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
      instances: 1,
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
