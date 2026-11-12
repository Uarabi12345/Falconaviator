import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 4001),
  roundIntervalMs: Number(process.env.ROUND_INTERVAL_MS || 8000),
  bettingWindowMs: Number(process.env.BETTING_WINDOW_MS || 5000),
  growthRate: Number(process.env.GROWTH_RATE || 0.00006),
  maxMultiplier: Number(process.env.MAX_MULTIPLIER || 1000),
  previewQueueSize: Number(process.env.PREVIEW_QUEUE_SIZE || 5),
  adminPassword: process.env.ADMIN_PASSWORD || 'Johntsimonikennedyalwikanza001',
  startingCredits:0,
};