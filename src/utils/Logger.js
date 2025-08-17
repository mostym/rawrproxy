const winston = require('winston');
const path = require('path');
const fs = require('fs');
const rfs = require('rotating-file-stream');

class Logger {
    constructor() {
        this.ensureLogDirectory();
        this.logger = this.createLogger();
        this.stream = {
            write: (message) => {
                this.logger.info(message.trim());
            }
        };
    }

    ensureLogDirectory() {
        const logDir = path.dirname(process.env.LOG_FILE_PATH || './logs/proxy.log');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }

    createLogger() {
        const logLevel = process.env.LOG_LEVEL || 'info';
        const logFile = process.env.LOG_FILE_PATH || './logs/proxy.log';

        const logger = winston.createLogger({
            level: logLevel,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.json()
            ),
            defaultMeta: { service: 'proxy-server' },
            transports: [
                new winston.transports.File({ 
                    filename: logFile.replace('.log', '.error.log'), 
                    level: 'error',
                    maxsize: 10485760,
                    maxFiles: 5
                }),
                new winston.transports.File({ 
                    filename: logFile,
                    maxsize: 10485760,
                    maxFiles: 10
                })
            ]
        });

        if (process.env.NODE_ENV !== 'production') {
            logger.add(new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.simple()
                )
            }));
        }

        return logger;
    }

    info(message, meta = {}) {
        this.logger.info(message, meta);
    }

    warn(message, meta = {}) {
        this.logger.warn(message, meta);
    }

    error(message, meta = {}) {
        this.logger.error(message, meta);
    }

    debug(message, meta = {}) {
        this.logger.debug(message, meta);
    }

    http(message, meta = {}) {
        this.logger.http(message, meta);
    }

    logRequest(req, res, responseTime) {
        const log = {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.originalUrl,
            ip: req.ip,
            userAgent: req.get('user-agent'),
            statusCode: res.statusCode,
            responseTime: `${responseTime}ms`,
            user: req.user?.username
        };

        if (res.statusCode >= 400) {
            this.error('Request failed', log);
        } else {
            this.info('Request completed', log);
        }
    }

    logProxyRequest(type, target, status, duration) {
        this.info('Proxy request', {
            type,
            target,
            status,
            duration: `${duration}ms`,
            timestamp: new Date().toISOString()
        });
    }

    getStats() {
        return {
            logLevel: this.logger.level,
            transports: this.logger.transports.length,
            logFile: process.env.LOG_FILE_PATH || './logs/proxy.log'
        };
    }
}

module.exports = Logger;