const Redis = require('ioredis');
const Logger = require('../utils/Logger');

class RedisCache {
    constructor(config = {}) {
        this.logger = new Logger();
        this.config = {
            host: config.host || process.env.REDIS_HOST || 'localhost',
            port: config.port || process.env.REDIS_PORT || 6379,
            password: config.password || process.env.REDIS_PASSWORD,
            db: config.db || process.env.REDIS_DB || 0,
            keyPrefix: config.keyPrefix || 'rawrproxy:',
            ttl: config.ttl || 3600, // Default TTL: 1 hour
            enableOfflineQueue: true,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            }
        };

        this.redis = null;
        this.connected = false;
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            errors: 0
        };
    }

    async connect() {
        try {
            this.redis = new Redis({
                host: this.config.host,
                port: this.config.port,
                password: this.config.password,
                db: this.config.db,
                keyPrefix: this.config.keyPrefix,
                enableOfflineQueue: this.config.enableOfflineQueue,
                maxRetriesPerRequest: this.config.maxRetriesPerRequest,
                retryStrategy: this.config.retryStrategy,
                lazyConnect: true
            });

            this.redis.on('connect', () => {
                this.connected = true;
                this.logger.info('Redis connected successfully');
            });

            this.redis.on('error', (err) => {
                this.logger.error(`Redis error: ${err.message}`);
                this.stats.errors++;
            });

            this.redis.on('close', () => {
                this.connected = false;
                this.logger.warn('Redis connection closed');
            });

            await this.redis.connect();
            return true;
        } catch (error) {
            this.logger.error(`Failed to connect to Redis: ${error.message}`);
            this.connected = false;
            return false;
        }
    }

    async get(key) {
        if (!this.connected) return null;

        try {
            const value = await this.redis.get(key);
            if (value) {
                this.stats.hits++;
                return JSON.parse(value);
            }
            this.stats.misses++;
            return null;
        } catch (error) {
            this.logger.error(`Redis GET error for key ${key}: ${error.message}`);
            this.stats.errors++;
            return null;
        }
    }

    async set(key, value, ttl = null) {
        if (!this.connected) return false;

        try {
            const serialized = JSON.stringify(value);
            const expiry = ttl || this.config.ttl;
            
            if (expiry > 0) {
                await this.redis.setex(key, expiry, serialized);
            } else {
                await this.redis.set(key, serialized);
            }
            
            this.stats.sets++;
            return true;
        } catch (error) {
            this.logger.error(`Redis SET error for key ${key}: ${error.message}`);
            this.stats.errors++;
            return false;
        }
    }

    async del(key) {
        if (!this.connected) return false;

        try {
            await this.redis.del(key);
            this.stats.deletes++;
            return true;
        } catch (error) {
            this.logger.error(`Redis DEL error for key ${key}: ${error.message}`);
            this.stats.errors++;
            return false;
        }
    }

    async flush(pattern = null) {
        if (!this.connected) return false;

        try {
            if (pattern) {
                const keys = await this.redis.keys(pattern);
                if (keys.length > 0) {
                    await this.redis.del(...keys);
                }
            } else {
                await this.redis.flushdb();
            }
            return true;
        } catch (error) {
            this.logger.error(`Redis FLUSH error: ${error.message}`);
            this.stats.errors++;
            return false;
        }
    }

    // Cache HTTP responses
    async cacheResponse(url, response, ttl = 300) {
        const key = `response:${url}`;
        return await this.set(key, {
            status: response.status,
            headers: response.headers,
            body: response.body,
            cached_at: Date.now()
        }, ttl);
    }

    async getCachedResponse(url) {
        const key = `response:${url}`;
        return await this.get(key);
    }

    // Session storage
    async setSession(sessionId, data, ttl = 86400) {
        const key = `session:${sessionId}`;
        return await this.set(key, data, ttl);
    }

    async getSession(sessionId) {
        const key = `session:${sessionId}`;
        return await this.get(key);
    }

    async deleteSession(sessionId) {
        const key = `session:${sessionId}`;
        return await this.del(key);
    }

    // Rate limiting
    async incrementRateLimit(identifier, window = 60) {
        if (!this.connected) return null;

        const key = `ratelimit:${identifier}`;
        try {
            const multi = this.redis.multi();
            multi.incr(key);
            multi.expire(key, window);
            const results = await multi.exec();
            return results[0][1]; // Return the count
        } catch (error) {
            this.logger.error(`Rate limit increment error: ${error.message}`);
            return null;
        }
    }

    async getRateLimit(identifier) {
        const key = `ratelimit:${identifier}`;
        const count = await this.redis.get(key);
        return count ? parseInt(count) : 0;
    }

    // Backend health status caching
    async setBackendHealth(backendId, health, ttl = 30) {
        const key = `backend:health:${backendId}`;
        return await this.set(key, health, ttl);
    }

    async getBackendHealth(backendId) {
        const key = `backend:health:${backendId}`;
        return await this.get(key);
    }

    // Distributed locks for coordination
    async acquireLock(resource, ttl = 10000) {
        if (!this.connected) return null;

        const lockId = `${Date.now()}:${Math.random()}`;
        const key = `lock:${resource}`;
        
        try {
            const result = await this.redis.set(key, lockId, 'PX', ttl, 'NX');
            return result === 'OK' ? lockId : null;
        } catch (error) {
            this.logger.error(`Lock acquisition error: ${error.message}`);
            return null;
        }
    }

    async releaseLock(resource, lockId) {
        if (!this.connected) return false;

        const key = `lock:${resource}`;
        
        try {
            const currentLockId = await this.redis.get(key);
            if (currentLockId === lockId) {
                await this.redis.del(key);
                return true;
            }
            return false;
        } catch (error) {
            this.logger.error(`Lock release error: ${error.message}`);
            return false;
        }
    }

    // Pub/Sub for cluster coordination
    async publish(channel, message) {
        if (!this.connected) return false;

        try {
            await this.redis.publish(channel, JSON.stringify(message));
            return true;
        } catch (error) {
            this.logger.error(`Publish error: ${error.message}`);
            return false;
        }
    }

    async subscribe(channel, callback) {
        if (!this.connected) return false;

        try {
            const subscriber = this.redis.duplicate();
            await subscriber.subscribe(channel);
            
            subscriber.on('message', (ch, message) => {
                if (ch === channel) {
                    try {
                        const parsed = JSON.parse(message);
                        callback(parsed);
                    } catch (error) {
                        this.logger.error(`Message parse error: ${error.message}`);
                    }
                }
            });
            
            return true;
        } catch (error) {
            this.logger.error(`Subscribe error: ${error.message}`);
            return false;
        }
    }

    getStats() {
        const hitRate = this.stats.hits + this.stats.misses > 0
            ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
            : 0;

        return {
            ...this.stats,
            hitRate: `${hitRate}%`,
            connected: this.connected
        };
    }

    async disconnect() {
        if (this.redis) {
            await this.redis.quit();
            this.connected = false;
            this.logger.info('Redis disconnected');
        }
    }
}

module.exports = RedisCache;