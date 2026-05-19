const path = require('path');
const home = require('os').homedir();

module.exports = {
  apps: [
    {
      name: 'bam-channel',
      script: 'npx',
      args: 'tsx src/cli.ts channel',
      cwd: path.resolve(__dirname),
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'bam-join',
      script: 'npx',
      args: 'tsx src/cli.ts join --auth user',
      cwd: path.resolve(__dirname),
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
