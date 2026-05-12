import 'dotenv/config';
import logger from './utils/logger.js';
import { sequelize } from './config/database.js';
import { EtlJob, MetricsDaily, MetricsSession } from './models/index.js';

async function bootstrap() {
  try {
    await sequelize.authenticate();
    logger.info('Database connected');

    await EtlJob.sync();
    logger.info('etl_jobs ready');

    await MetricsDaily.sync();
    logger.info('metrics_daily ready');

    await MetricsSession.sync();
    logger.info('metrics_session ready');

    await EtlJob.findOrCreate({
      where: { job_key: 'metrics' },
      defaults: { last_processed_activity_id: 0 },
    });
    logger.info('etl_jobs[metrics] row present');

    process.exit(0);
  } catch (error) {
    logger.error('Bootstrap failed', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

bootstrap();
