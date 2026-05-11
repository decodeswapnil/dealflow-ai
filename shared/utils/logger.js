import winston from 'winston';
import path from 'path';

const { combine, timestamp, json, errors } = winston.format;

export function createLogger(agentName) {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { agent: agentName },
    format: combine(
      timestamp(),
      errors({ stack: true }),
      json()
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ 
        filename: path.join(process.cwd(), 'logs', `${agentName}.log`),
        maxsize: 5242880, // 5MB
        maxFiles: 5
      })
    ],
    exceptionHandlers: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: path.join(process.cwd(), 'logs', 'exceptions.log') })
    ]
  });
}