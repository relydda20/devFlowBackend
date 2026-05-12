import 'dotenv/config';
import { fileURLToPath } from 'url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import logger from './utils/logger.js';
import telemetryRouter from './routes/telemetry.routes.js';
import healthRouter from './routes/health.routes.js';
import authRouter from './routes/auth.routes.js';
import tokenRouter from './routes/token.routes.js';
import metricsRouter from './routes/metrics.routes.js';
import * as metricsEtlScheduler from './services/metrics-etl-scheduler.js';

const app = express();

app.use(helmet());
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

app.use('/api/v1', healthRouter);
app.use('/api/v1', tokenRouter);
app.use('/api/v1', authRouter);
app.use('/api/v1', telemetryRouter);
app.use('/api/v1', metricsRouter);

app.use((err, req, res, _next) => {
  logger.error('Unhandled request error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`);
    metricsEtlScheduler.start();
  });

  const shutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down scheduler`);
    metricsEtlScheduler.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
