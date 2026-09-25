// pm2 process definition. instances must stay at 1: scheduler.js runs node-cron
// in-process, so a second instance would double-publish due posts and double-run
// the media cleanup job.
module.exports = {
  apps: [
    {
      name: 'postfalcon',
      script: './index.js',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
