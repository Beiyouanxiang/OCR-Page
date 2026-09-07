// PM2 配置：在项目根目录执行 pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'ocr-page',
      script: './server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOST: '127.0.0.1',
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      max_memory_restart: '300M',
    },
  ],
}
