const Logger = require('../utils/Logger');

class RateLimiter {
    constructor(options = {}) {
        this.logger = new Logger();
        this.redisCache = options.redisCache || null;
        this.useRedis = this.redisCache && this.redisCache.connected;
        
        // Configuration
        this.rules = new Map();
        this.defaultRule = {
            windowMs: options.windowMs || 60000, // 1 minute
            maxRequests: options.maxRequests || 100,
            keyGenerator: options.keyGenerator || ((req) => req.ip),
            skipSuccessfulRequests: options.skipSuccessfulRequests || false,
            skipFailedRequests: options.skipFailedRequests || false,
            message: options.message || 'Too many requests, please try again later.',
            statusCode: options.statusCode || 429
        };
        
        // In-memory store (fallback when Redis is not available)
        this.memoryStore = new Map();
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
        
        this.logger.info(`Rate limiter initialized (Redis: ${this.useRedis ? 'enabled' : 'disabled'})`);
    }

    // Add a custom rule for specific paths or conditions
    addRule(identifier, rule) {
        this.rules.set(identifier, { ...this.defaultRule, ...rule });
        this.logger.info(`Rate limit rule added: ${identifier}`);
    }

    // Get rule for request
    getRule(req) {
        // Check for path-specific rules
        for (const [identifier, rule] of this.rules) {
            if (typeof identifier === 'string' && req.path.startsWith(identifier)) {
                return rule;
            }
            if (identifier instanceof RegExp && identifier.test(req.path)) {
                return rule;
            }
            if (typeof identifier === 'function' && identifier(req)) {
                return rule;
            }
        }
        return this.defaultRule;
    }

    // Main middleware function
    middleware() {
        return async (req, res, next) => {
            try {
                const rule = this.getRule(req);
                const key = rule.keyGenerator(req);
                const identifier = `${req.path}:${key}`;
                
                // Check if we should skip this request
                if (rule.skip && await rule.skip(req)) {
                    return next();
                }
                
                // Get current count
                const count = await this.increment(identifier, rule.windowMs);
                
                // Set rate limit headers
                res.setHeader('X-RateLimit-Limit', rule.maxRequests);
                res.setHeader('X-RateLimit-Remaining', Math.max(0, rule.maxRequests - count));
                res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rule.windowMs).toISOString());
                
                // Check if limit exceeded
                if (count > rule.maxRequests) {
                    res.setHeader('Retry-After', Math.ceil(rule.windowMs / 1000));
                    
                    // Log rate limit hit
                    this.logger.warn(`Rate limit exceeded for ${identifier}: ${count}/${rule.maxRequests}`);
                    
                    // Call onLimitReached if defined
                    if (rule.onLimitReached) {
                        await rule.onLimitReached(req, res);
                    }
                    
                    return res.status(rule.statusCode).json({
                        error: 'Rate limit exceeded',
                        message: rule.message,
                        retryAfter: Math.ceil(rule.windowMs / 1000)
                    });
                }
                
                // Store reference to check in response
                res.locals.rateLimitRule = rule;
                res.locals.rateLimitIdentifier = identifier;
                
                // Continue to next middleware
                next();
                
                // After response, check if we should count this request
                res.on('finish', async () => {
                    if (rule.skipSuccessfulRequests && res.statusCode < 400) {
                        await this.decrement(identifier);
                    }
                    if (rule.skipFailedRequests && res.statusCode >= 400) {
                        await this.decrement(identifier);
                    }
                });
            } catch (error) {
                this.logger.error(`Rate limiter error: ${error.message}`);
                // On error, allow request to continue
                next();
            }
        };
    }

    // Increment counter
    async increment(identifier, windowMs) {
        if (this.useRedis) {
            try {
                const count = await this.redisCache.incrementRateLimit(identifier, Math.ceil(windowMs / 1000));
                if (count !== null) return count;
            } catch (error) {
                this.logger.error(`Redis rate limit error: ${error.message}`);
            }
        }
        
        // Fallback to memory store
        const now = Date.now();
        const windowStart = now - windowMs;
        
        if (!this.memoryStore.has(identifier)) {
            this.memoryStore.set(identifier, []);
        }
        
        const requests = this.memoryStore.get(identifier);
        requests.push(now);
        
        // Clean old requests
        const validRequests = requests.filter(time => time > windowStart);
        this.memoryStore.set(identifier, validRequests);
        
        return validRequests.length;
    }

    // Decrement counter (for skipped requests)
    async decrement(identifier) {
        if (this.useRedis) {
            try {
                const key = `ratelimit:${identifier}`;
                const current = await this.redisCache.redis.get(key);
                if (current && parseInt(current) > 0) {
                    await this.redisCache.redis.decr(key);
                }
            } catch (error) {
                this.logger.error(`Redis decrement error: ${error.message}`);
            }
        } else {
            // For memory store, remove last request
            const requests = this.memoryStore.get(identifier);
            if (requests && requests.length > 0) {
                requests.pop();
            }
        }
    }

    // Cleanup old entries from memory store
    cleanup() {
        const now = Date.now();
        const maxAge = Math.max(...Array.from(this.rules.values()).map(r => r.windowMs), this.defaultRule.windowMs);
        
        for (const [identifier, requests] of this.memoryStore) {
            const validRequests = requests.filter(time => time > now - maxAge);
            if (validRequests.length === 0) {
                this.memoryStore.delete(identifier);
            } else {
                this.memoryStore.set(identifier, validRequests);
            }
        }
    }

    // Reset rate limit for specific identifier
    async reset(identifier) {
        if (this.useRedis) {
            await this.redisCache.del(`ratelimit:${identifier}`);
        }
        this.memoryStore.delete(identifier);
    }

    // Get current status for identifier
    async getStatus(identifier, rule = null) {
        rule = rule || this.defaultRule;
        
        let count = 0;
        if (this.useRedis) {
            count = await this.redisCache.getRateLimit(identifier);
        } else {
            const requests = this.memoryStore.get(identifier) || [];
            const windowStart = Date.now() - rule.windowMs;
            count = requests.filter(time => time > windowStart).length;
        }
        
        return {
            count,
            limit: rule.maxRequests,
            remaining: Math.max(0, rule.maxRequests - count),
            resetAt: new Date(Date.now() + rule.windowMs)
        };
    }

    // Create specialized rate limiters
    static createApiLimiter(redisCache) {
        const limiter = new RateLimiter({
            redisCache,
            windowMs: 60000, // 1 minute
            maxRequests: 60, // 60 requests per minute
            keyGenerator: (req) => {
                // Use API key if present, otherwise IP
                return req.headers['x-api-key'] || req.ip;
            }
        });
        
        // Add stricter limits for sensitive endpoints
        limiter.addRule('/api/admin', {
            windowMs: 60000,
            maxRequests: 10,
            message: 'Admin API rate limit exceeded'
        });
        
        return limiter;
    }

    static createLoginLimiter(redisCache) {
        return new RateLimiter({
            redisCache,
            windowMs: 900000, // 15 minutes
            maxRequests: 5, // 5 attempts per 15 minutes
            keyGenerator: (req) => {
                // Use username + IP for more granular limiting
                const username = req.body?.username || req.body?.email || '';
                return `${username}:${req.ip}`;
            },
            skipSuccessfulRequests: true, // Don't count successful logins
            message: 'Too many login attempts. Please try again later.',
            onLimitReached: async (req, res) => {
                // Could trigger additional security measures here
                console.log(`Excessive login attempts from ${req.ip}`);
            }
        });
    }

    static createWebSocketLimiter(redisCache) {
        return new RateLimiter({
            redisCache,
            windowMs: 60000,
            maxRequests: 10, // 10 new connections per minute
            keyGenerator: (req) => `ws:${req.ip}`,
            message: 'Too many WebSocket connections'
        });
    }

    static createDynamicLimiter(redisCache) {
        const limiter = new RateLimiter({
            redisCache,
            windowMs: 60000,
            maxRequests: 100
        });
        
        // Adjust limits based on load
        setInterval(async () => {
            const metrics = await limiter.getMetrics();
            if (metrics.avgResponseTime > 1000) {
                // Slow responses, reduce limit
                limiter.defaultRule.maxRequests = Math.max(50, limiter.defaultRule.maxRequests - 10);
            } else if (metrics.avgResponseTime < 200) {
                // Fast responses, increase limit
                limiter.defaultRule.maxRequests = Math.min(200, limiter.defaultRule.maxRequests + 10);
            }
        }, 30000);
        
        return limiter;
    }

    // Get metrics for monitoring
    async getMetrics() {
        const metrics = {
            rulesCount: this.rules.size,
            memoryStoreSize: this.memoryStore.size,
            useRedis: this.useRedis
        };
        
        if (this.useRedis) {
            try {
                const keys = await this.redisCache.redis.keys('ratelimit:*');
                metrics.redisKeysCount = keys.length;
            } catch (error) {
                metrics.redisError = error.message;
            }
        }
        
        return metrics;
    }

    // Cleanup on shutdown
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.memoryStore.clear();
    }
}

module.exports = RateLimiter;