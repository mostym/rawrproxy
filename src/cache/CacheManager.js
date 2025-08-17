const NodeCache = require('node-cache');
const redis = require('redis');

class CacheManager {
    constructor(logger) {
        this.logger = logger;
        this.enabled = process.env.CACHE_ENABLED === 'true';
        this.ttl = parseInt(process.env.CACHE_TTL) || 300;
        
        if (this.enabled) {
            this.initializeCache();
        }
    }

    async initializeCache() {
        if (process.env.REDIS_URL) {
            try {
                this.redisClient = redis.createClient({
                    url: process.env.REDIS_URL
                });
                
                this.redisClient.on('error', (err) => {
                    this.logger.error('Redis client error:', err);
                    this.fallbackToMemoryCache();
                });

                await this.redisClient.connect();
                this.logger.info('Connected to Redis cache');
                this.cacheType = 'redis';
            } catch (error) {
                this.logger.warn('Failed to connect to Redis, using memory cache', error);
                this.fallbackToMemoryCache();
            }
        } else {
            this.fallbackToMemoryCache();
        }
    }

    fallbackToMemoryCache() {
        this.memoryCache = new NodeCache({ 
            stdTTL: this.ttl,
            checkperiod: 60,
            useClones: false
        });
        this.cacheType = 'memory';
        this.logger.info('Using in-memory cache');
    }

    async get(key) {
        if (!this.enabled) return null;

        try {
            if (this.cacheType === 'redis' && this.redisClient) {
                const data = await this.redisClient.get(this.hashKey(key));
                return data ? JSON.parse(data) : null;
            } else if (this.memoryCache) {
                return this.memoryCache.get(this.hashKey(key));
            }
        } catch (error) {
            this.logger.error('Cache get error:', error);
            return null;
        }
    }

    async set(key, value, ttl = null) {
        if (!this.enabled) return;

        const cacheTTL = ttl || this.ttl;

        try {
            if (this.cacheType === 'redis' && this.redisClient) {
                await this.redisClient.setEx(
                    this.hashKey(key),
                    cacheTTL,
                    JSON.stringify(value)
                );
            } else if (this.memoryCache) {
                this.memoryCache.set(this.hashKey(key), value, cacheTTL);
            }
        } catch (error) {
            this.logger.error('Cache set error:', error);
        }
    }

    async delete(key) {
        if (!this.enabled) return;

        try {
            if (this.cacheType === 'redis' && this.redisClient) {
                await this.redisClient.del(this.hashKey(key));
            } else if (this.memoryCache) {
                this.memoryCache.del(this.hashKey(key));
            }
        } catch (error) {
            this.logger.error('Cache delete error:', error);
        }
    }

    async flush() {
        if (!this.enabled) return;

        try {
            if (this.cacheType === 'redis' && this.redisClient) {
                await this.redisClient.flushAll();
            } else if (this.memoryCache) {
                this.memoryCache.flushAll();
            }
            this.logger.info('Cache flushed');
        } catch (error) {
            this.logger.error('Cache flush error:', error);
        }
    }

    async getStats() {
        if (!this.enabled) return { enabled: false };

        try {
            if (this.cacheType === 'redis' && this.redisClient) {
                const info = await this.redisClient.info('stats');
                return {
                    type: 'redis',
                    enabled: true,
                    info
                };
            } else if (this.memoryCache) {
                return {
                    type: 'memory',
                    enabled: true,
                    keys: this.memoryCache.keys().length,
                    hits: this.memoryCache.getStats().hits,
                    misses: this.memoryCache.getStats().misses
                };
            }
        } catch (error) {
            this.logger.error('Cache stats error:', error);
            return { enabled: this.enabled, error: error.message };
        }
    }

    hashKey(key) {
        const crypto = require('crypto');
        return `proxy:${crypto.createHash('md5').update(key).digest('hex')}`;
    }

    shouldCache(req, res) {
        if (!this.enabled) return false;
        
        if (req.method !== 'GET' && req.method !== 'HEAD') return false;
        
        if (res.statusCode !== 200) return false;
        
        const contentType = res.getHeader('content-type');
        if (contentType && contentType.includes('text/event-stream')) return false;
        
        const cacheControl = res.getHeader('cache-control');
        if (cacheControl && (cacheControl.includes('no-cache') || cacheControl.includes('no-store'))) {
            return false;
        }
        
        return true;
    }

    getCacheKey(req) {
        const url = req.originalUrl || req.url;
        const headers = JSON.stringify({
            'accept': req.headers.accept,
            'accept-language': req.headers['accept-language'],
            'accept-encoding': req.headers['accept-encoding']
        });
        
        return `${req.method}:${url}:${headers}`;
    }
}

module.exports = CacheManager;