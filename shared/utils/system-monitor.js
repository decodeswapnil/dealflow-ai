import os from 'os';
import { createLogger } from './logger.js';

const logger = createLogger('system-monitor');

/**
 * Checks if the system memory is constrained.
 * Reads RAM_MANAGEMENT_ENABLED to respect user preference.
 *
 * @param {number} threshold - Utilization threshold (0.0 to 1.0), default 0.9 (90%)
 * @returns {boolean} True if memory usage > threshold AND management is enabled
 */
export function isMemoryConstrained(threshold = 0.9) {
  // Respect the feature toggle
  if (process.env.RAM_MANAGEMENT_ENABLED === 'false') {
    return false;
  }

  try {
    const free = os.freemem();
    const total = os.totalmem();
    const used = total - free;
    const utilization = used / total;

    if (utilization > threshold) {
      logger.warn(`High memory utilization detected: ${(utilization * 100).toFixed(2)}% (${(free / 1024 / 1024 / 1024).toFixed(2)} GB free of ${(total / 1024 / 1024 / 1024).toFixed(2)} GB total). Triggering constraints.`);
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Failed to check system memory:', { error: error.message });
    return false;
  }
}
