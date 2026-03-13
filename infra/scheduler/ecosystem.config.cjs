module.exports = {
  apps: [{
    name: "akari",
    script: "dist/cli.js",
    args: "start",
    cwd: __dirname,
    env: {
      NODE_ENV: "production",
      AGENT_BACKEND: "claude",
    },
    // Remove CLAUDECODE to prevent nested-session guard
    filter_env: ["CLAUDECODE"],
    // Logging
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "../../.scheduler/logs/pm2-error.log",
    out_file: "../../.scheduler/logs/pm2-out.log",
    merge_logs: true,
    // Restart policy
    max_restarts: 10,
    restart_delay: 5000,
    autorestart: true,
  }],
};
