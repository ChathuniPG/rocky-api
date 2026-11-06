/**
 * PM2 process file for running rocky-api in production on EC2 (NFR-OPS-01).
 *
 * Comparable to a systemd unit for a Spring Boot `java -jar` app: it says what to run,
 * from which directory, how many copies, and how to stop and restart it.
 *
 * Usage on the server (deploy/redeploy.sh does this for you):
 *   pm2 start ecosystem.config.cjs                  first start
 *   pm2 reload ecosystem.config.cjs --update-env    after a new build
 *   pm2 startup && pm2 save                         once, so PM2 restores the app after a reboot
 *
 * `.cjs` because PM2 loads this file with require(); the extension keeps it CommonJS
 * even if package.json ever switches to "type": "module".
 */
module.exports = {
  apps: [
    {
      name: 'rocky-api',

      // Compiled entry point. tsconfig.build.json sets rootDir to ./src, so src/main.ts
      // builds to dist/main.js. `npm run start:prod` runs the same file.
      script: 'dist/main.js',

      // Repository root. Both the Nest ConfigModule and prisma.config.ts read `.env` from
      // the current working directory, so the process must start here.
      cwd: __dirname,

      // ADR-012: rate-limit counters live in process memory. Cluster mode or more than one
      // instance would give each process its own counters and multiply the limits.
      exec_mode: 'fork',
      instances: 1,

      // NFR-OPS-01: restart automatically when the process crashes.
      autorestart: true,

      // main.ts enables shutdown hooks: on the stop signal Nest closes the HTTP server,
      // disconnects Prisma and releases the Firebase SDK. PM2's default (1.6 s) can cut
      // that short with SIGKILL; 10 s leaves room for in-flight requests to finish.
      kill_timeout: 10000,

      // Overrides NODE_ENV from `.env` (process variables take precedence over the file).
      // All other configuration and every secret stays in `.env`, never in this file.
      env: {
        NODE_ENV: 'production',
      },

      // Prefix every line in ~/.pm2/logs/rocky-api-{out,error}.log with a timestamp, so
      // crashes and restarts can be correlated with request logs (NFR-OPS-04).
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
