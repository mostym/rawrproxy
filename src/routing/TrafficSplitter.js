const crypto = require('crypto');
const Logger = require('../utils/Logger');

class TrafficSplitter {
    constructor(options = {}) {
        this.logger = new Logger();
        this.experiments = new Map();
        this.redisCache = options.redisCache || null;
        
        // Statistics tracking
        this.stats = {
            requests: new Map(),
            conversions: new Map()
        };
        
        this.logger.info('Traffic splitter initialized');
    }

    // Create a new A/B test experiment
    createExperiment(config) {
        const experiment = {
            id: config.id || crypto.randomBytes(16).toString('hex'),
            name: config.name,
            description: config.description || '',
            enabled: config.enabled !== false,
            startDate: config.startDate || new Date(),
            endDate: config.endDate || null,
            
            // Traffic allocation
            trafficPercentage: config.trafficPercentage || 100, // % of traffic to include
            
            // Targeting rules
            targeting: {
                paths: config.targeting?.paths || [], // URL paths to target
                headers: config.targeting?.headers || {}, // Required headers
                cookies: config.targeting?.cookies || {}, // Required cookies
                ipRanges: config.targeting?.ipRanges || [], // IP ranges to target
                userAgents: config.targeting?.userAgents || [], // User agent patterns
                custom: config.targeting?.custom || null // Custom function
            },
            
            // Variants
            variants: config.variants || [
                { id: 'control', weight: 50, backend: null },
                { id: 'treatment', weight: 50, backend: null }
            ],
            
            // Sticky sessions
            sticky: {
                enabled: config.sticky?.enabled !== false,
                duration: config.sticky?.duration || 86400000, // 24 hours
                method: config.sticky?.method || 'cookie' // 'cookie', 'ip', 'header'
            },
            
            // Success metrics
            metrics: config.metrics || {
                primary: null, // Primary metric to optimize
                secondary: [] // Secondary metrics to track
            },
            
            // Callbacks
            onVariantAssigned: config.onVariantAssigned || null,
            onConversion: config.onConversion || null
        };
        
        // Normalize variant weights
        const totalWeight = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
        experiment.variants.forEach(v => {
            v.normalizedWeight = v.weight / totalWeight;
        });
        
        this.experiments.set(experiment.id, experiment);
        this.logger.info(`Experiment created: ${experiment.name} (${experiment.id})`);
        
        return experiment;
    }

    // Determine which variant a request should receive
    async getVariant(experimentId, req) {
        const experiment = this.experiments.get(experimentId);
        if (!experiment || !experiment.enabled) {
            return null;
        }
        
        // Check if experiment is active
        const now = new Date();
        if (experiment.endDate && now > experiment.endDate) {
            return null;
        }
        if (now < experiment.startDate) {
            return null;
        }
        
        // Check targeting rules
        if (!this.matchesTargeting(experiment, req)) {
            return null;
        }
        
        // Check traffic percentage
        if (experiment.trafficPercentage < 100) {
            const hash = this.hashRequest(req);
            const threshold = experiment.trafficPercentage / 100;
            if (hash > threshold) {
                return null; // Not included in experiment
            }
        }
        
        // Check for sticky assignment
        if (experiment.sticky.enabled) {
            const existingVariant = await this.getStickyVariant(experiment, req);
            if (existingVariant) {
                this.trackRequest(experiment.id, existingVariant.id);
                return existingVariant;
            }
        }
        
        // Assign new variant
        const variant = this.assignVariant(experiment, req);
        
        if (variant && experiment.sticky.enabled) {
            await this.setStickyVariant(experiment, req, variant);
        }
        
        // Track assignment
        this.trackRequest(experiment.id, variant.id);
        
        // Call callback if defined
        if (experiment.onVariantAssigned) {
            try {
                await experiment.onVariantAssigned(variant, req);
            } catch (error) {
                this.logger.error(`Variant assignment callback error: ${error.message}`);
            }
        }
        
        return variant;
    }

    // Check if request matches targeting rules
    matchesTargeting(experiment, req) {
        const targeting = experiment.targeting;
        
        // Check paths
        if (targeting.paths.length > 0) {
            const matches = targeting.paths.some(path => {
                if (typeof path === 'string') {
                    return req.path.startsWith(path);
                }
                if (path instanceof RegExp) {
                    return path.test(req.path);
                }
                return false;
            });
            if (!matches) return false;
        }
        
        // Check headers
        for (const [header, value] of Object.entries(targeting.headers)) {
            if (req.headers[header] !== value) {
                return false;
            }
        }
        
        // Check cookies
        for (const [cookie, value] of Object.entries(targeting.cookies)) {
            if (req.cookies && req.cookies[cookie] !== value) {
                return false;
            }
        }
        
        // Check IP ranges
        if (targeting.ipRanges.length > 0) {
            const clientIp = req.ip || req.connection.remoteAddress;
            const matches = targeting.ipRanges.some(range => 
                this.ipInRange(clientIp, range)
            );
            if (!matches) return false;
        }
        
        // Check user agents
        if (targeting.userAgents.length > 0) {
            const userAgent = req.headers['user-agent'] || '';
            const matches = targeting.userAgents.some(pattern => {
                if (typeof pattern === 'string') {
                    return userAgent.includes(pattern);
                }
                if (pattern instanceof RegExp) {
                    return pattern.test(userAgent);
                }
                return false;
            });
            if (!matches) return false;
        }
        
        // Check custom function
        if (targeting.custom) {
            try {
                return targeting.custom(req);
            } catch (error) {
                this.logger.error(`Custom targeting error: ${error.message}`);
                return false;
            }
        }
        
        return true;
    }

    // Assign a variant based on weights
    assignVariant(experiment, req) {
        const random = this.hashRequest(req);
        let cumulative = 0;
        
        for (const variant of experiment.variants) {
            cumulative += variant.normalizedWeight;
            if (random <= cumulative) {
                return variant;
            }
        }
        
        // Fallback to last variant
        return experiment.variants[experiment.variants.length - 1];
    }

    // Generate consistent hash for request
    hashRequest(req) {
        const identifier = req.ip || req.connection.remoteAddress || Math.random().toString();
        const hash = crypto.createHash('md5').update(identifier).digest('hex');
        // Convert first 8 hex chars to number between 0 and 1
        return parseInt(hash.substring(0, 8), 16) / 0xffffffff;
    }

    // Get sticky variant assignment
    async getStickyVariant(experiment, req) {
        const key = this.getStickyKey(experiment, req);
        
        if (this.redisCache && this.redisCache.connected) {
            try {
                const cached = await this.redisCache.get(`experiment:${experiment.id}:${key}`);
                if (cached) {
                    return experiment.variants.find(v => v.id === cached);
                }
            } catch (error) {
                this.logger.error(`Redis get error: ${error.message}`);
            }
        }
        
        // Check cookie
        if (experiment.sticky.method === 'cookie' && req.cookies) {
            const cookieName = `exp_${experiment.id}`;
            const variantId = req.cookies[cookieName];
            if (variantId) {
                return experiment.variants.find(v => v.id === variantId);
            }
        }
        
        return null;
    }

    // Set sticky variant assignment
    async setStickyVariant(experiment, req, variant, res = null) {
        const key = this.getStickyKey(experiment, req);
        const ttl = Math.ceil(experiment.sticky.duration / 1000);
        
        if (this.redisCache && this.redisCache.connected) {
            try {
                await this.redisCache.set(
                    `experiment:${experiment.id}:${key}`,
                    variant.id,
                    ttl
                );
            } catch (error) {
                this.logger.error(`Redis set error: ${error.message}`);
            }
        }
        
        // Set cookie if response object is available
        if (experiment.sticky.method === 'cookie' && res) {
            const cookieName = `exp_${experiment.id}`;
            res.cookie(cookieName, variant.id, {
                maxAge: experiment.sticky.duration,
                httpOnly: true,
                secure: process.env.HTTPS_ENABLED === 'true'
            });
        }
    }

    // Get sticky key based on method
    getStickyKey(experiment, req) {
        switch (experiment.sticky.method) {
            case 'ip':
                return req.ip || req.connection.remoteAddress;
            case 'header':
                return req.headers['x-session-id'] || req.headers['x-user-id'] || req.ip;
            case 'cookie':
            default:
                return req.cookies?.sessionId || req.ip;
        }
    }

    // Check if IP is in range
    ipInRange(ip, range) {
        // Simple implementation - could be enhanced with proper CIDR support
        if (range.includes('/')) {
            // CIDR notation - simplified check
            const [subnet] = range.split('/');
            return ip.startsWith(subnet.split('.').slice(0, -1).join('.'));
        }
        return ip === range;
    }

    // Track request for statistics
    trackRequest(experimentId, variantId) {
        const key = `${experimentId}:${variantId}`;
        if (!this.stats.requests.has(key)) {
            this.stats.requests.set(key, 0);
        }
        this.stats.requests.set(key, this.stats.requests.get(key) + 1);
    }

    // Track conversion
    async trackConversion(experimentId, variantId, metric, value = 1) {
        const experiment = this.experiments.get(experimentId);
        if (!experiment) return;
        
        const key = `${experimentId}:${variantId}:${metric}`;
        if (!this.stats.conversions.has(key)) {
            this.stats.conversions.set(key, 0);
        }
        this.stats.conversions.set(key, this.stats.conversions.get(key) + value);
        
        // Call callback if defined
        if (experiment.onConversion) {
            try {
                await experiment.onConversion(variantId, metric, value);
            } catch (error) {
                this.logger.error(`Conversion callback error: ${error.message}`);
            }
        }
        
        // Store in Redis for persistence
        if (this.redisCache && this.redisCache.connected) {
            try {
                await this.redisCache.redis.hincrby(
                    `experiment:${experimentId}:conversions`,
                    `${variantId}:${metric}`,
                    value
                );
            } catch (error) {
                this.logger.error(`Redis conversion tracking error: ${error.message}`);
            }
        }
    }

    // Get experiment statistics
    async getExperimentStats(experimentId) {
        const experiment = this.experiments.get(experimentId);
        if (!experiment) return null;
        
        const stats = {
            experiment: {
                id: experiment.id,
                name: experiment.name,
                enabled: experiment.enabled,
                startDate: experiment.startDate,
                endDate: experiment.endDate
            },
            variants: {}
        };
        
        for (const variant of experiment.variants) {
            const requestKey = `${experimentId}:${variant.id}`;
            const requests = this.stats.requests.get(requestKey) || 0;
            
            stats.variants[variant.id] = {
                weight: variant.weight,
                requests: requests,
                conversions: {}
            };
            
            // Get conversions for each metric
            if (experiment.metrics.primary) {
                const conversionKey = `${experimentId}:${variant.id}:${experiment.metrics.primary}`;
                stats.variants[variant.id].conversions[experiment.metrics.primary] = 
                    this.stats.conversions.get(conversionKey) || 0;
            }
            
            for (const metric of experiment.metrics.secondary) {
                const conversionKey = `${experimentId}:${variant.id}:${metric}`;
                stats.variants[variant.id].conversions[metric] = 
                    this.stats.conversions.get(conversionKey) || 0;
            }
        }
        
        // Calculate statistical significance if enough data
        if (experiment.variants.length === 2 && experiment.metrics.primary) {
            const [control, treatment] = experiment.variants;
            const controlRequests = stats.variants[control.id].requests;
            const treatmentRequests = stats.variants[treatment.id].requests;
            const controlConversions = stats.variants[control.id].conversions[experiment.metrics.primary];
            const treatmentConversions = stats.variants[treatment.id].conversions[experiment.metrics.primary];
            
            if (controlRequests > 30 && treatmentRequests > 30) {
                stats.significance = this.calculateSignificance(
                    controlRequests, controlConversions,
                    treatmentRequests, treatmentConversions
                );
            }
        }
        
        return stats;
    }

    // Calculate statistical significance (simplified)
    calculateSignificance(n1, x1, n2, x2) {
        const p1 = x1 / n1;
        const p2 = x2 / n2;
        const p = (x1 + x2) / (n1 + n2);
        
        const se = Math.sqrt(p * (1 - p) * (1/n1 + 1/n2));
        const z = (p2 - p1) / se;
        
        // Two-tailed test
        const pValue = 2 * (1 - this.normalCDF(Math.abs(z)));
        
        return {
            controlRate: (p1 * 100).toFixed(2) + '%',
            treatmentRate: (p2 * 100).toFixed(2) + '%',
            lift: ((p2 - p1) / p1 * 100).toFixed(2) + '%',
            pValue: pValue.toFixed(4),
            significant: pValue < 0.05
        };
    }

    // Normal CDF approximation
    normalCDF(x) {
        const t = 1 / (1 + 0.2316419 * Math.abs(x));
        const d = 0.3989423 * Math.exp(-x * x / 2);
        const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
        return x > 0 ? 1 - p : p;
    }

    // Middleware for Express
    middleware() {
        return async (req, res, next) => {
            req.experiments = {};
            
            // Check all active experiments
            for (const [id, experiment] of this.experiments) {
                if (experiment.enabled) {
                    const variant = await this.getVariant(id, req);
                    if (variant) {
                        req.experiments[id] = variant;
                        
                        // Set response header for debugging
                        res.setHeader(`X-Experiment-${id}`, variant.id);
                        
                        // Set sticky cookie if needed
                        if (experiment.sticky.enabled && experiment.sticky.method === 'cookie') {
                            await this.setStickyVariant(experiment, req, variant, res);
                        }
                    }
                }
            }
            
            next();
        };
    }

    // Get all experiments
    getExperiments() {
        return Array.from(this.experiments.values());
    }

    // Update experiment
    updateExperiment(experimentId, updates) {
        const experiment = this.experiments.get(experimentId);
        if (experiment) {
            Object.assign(experiment, updates);
            this.logger.info(`Experiment updated: ${experimentId}`);
            return experiment;
        }
        return null;
    }

    // Delete experiment
    deleteExperiment(experimentId) {
        const deleted = this.experiments.delete(experimentId);
        if (deleted) {
            this.logger.info(`Experiment deleted: ${experimentId}`);
        }
        return deleted;
    }
}

module.exports = TrafficSplitter;