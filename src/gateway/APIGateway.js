const jsonpath = require('jsonpath');
const XMLBuilder = require('xmlbuilder2');
const Logger = require('../utils/Logger');
const crypto = require('crypto');

class APIGateway {
    constructor(options = {}) {
        this.logger = new Logger();
        this.routes = new Map();
        this.transformers = new Map();
        this.aggregators = new Map();
        this.validators = new Map();
        
        // Configuration
        this.config = {
            enableTransformation: options.enableTransformation !== false,
            enableAggregation: options.enableAggregation !== false,
            enableValidation: options.enableValidation !== false,
            enableVersioning: options.enableVersioning !== false,
            enableMocking: options.enableMocking || false,
            cacheDuration: options.cacheDuration || 60,
            timeout: options.timeout || 30000,
            retryPolicy: options.retryPolicy || { retries: 3, backoff: 'exponential' }
        };
        
        // Request/Response interceptors
        this.requestInterceptors = [];
        this.responseInterceptors = [];
        
        // API versioning
        this.versions = new Map();
        
        // Mock data store
        this.mockData = new Map();
        
        // Statistics
        this.stats = {
            requests: 0,
            transformations: 0,
            aggregations: 0,
            validationErrors: 0,
            mockResponses: 0
        };
        
        this.logger.info('API Gateway initialized');
    }

    // Register API route
    registerRoute(config) {
        const route = {
            id: config.id || crypto.randomBytes(16).toString('hex'),
            path: config.path,
            method: config.method || 'GET',
            version: config.version || 'v1',
            
            // Backend configuration
            backend: config.backend || null,
            backends: config.backends || [], // For aggregation
            
            // Transformations
            requestTransform: config.requestTransform || null,
            responseTransform: config.responseTransform || null,
            
            // Validation
            requestSchema: config.requestSchema || null,
            responseSchema: config.responseSchema || null,
            
            // Aggregation
            aggregation: config.aggregation || null,
            
            // Caching
            cache: config.cache || { enabled: false, duration: 60 },
            
            // Authentication
            auth: config.auth || { required: false, type: 'none' },
            
            // Rate limiting
            rateLimit: config.rateLimit || null,
            
            // Mock response
            mock: config.mock || null,
            
            // Documentation
            description: config.description || '',
            tags: config.tags || [],
            
            // Metrics
            metrics: config.metrics || { enabled: true }
        };
        
        const key = `${route.method}:${route.path}:${route.version}`;
        this.routes.set(key, route);
        
        // Register transformers if provided
        if (route.requestTransform) {
            this.registerTransformer(`${route.id}:request`, route.requestTransform);
        }
        if (route.responseTransform) {
            this.registerTransformer(`${route.id}:response`, route.responseTransform);
        }
        
        // Register validators if provided
        if (route.requestSchema) {
            this.registerValidator(`${route.id}:request`, route.requestSchema);
        }
        if (route.responseSchema) {
            this.registerValidator(`${route.id}:response`, route.responseSchema);
        }
        
        // Register aggregator if provided
        if (route.aggregation) {
            this.registerAggregator(route.id, route.aggregation);
        }
        
        this.logger.info(`Registered API route: ${key}`);
        return route;
    }

    // Register transformer
    registerTransformer(name, config) {
        const transformer = {
            name: name,
            type: config.type || 'json', // json, xml, text, binary
            
            // Transformation rules
            rules: config.rules || [],
            
            // Custom transformation function
            transform: config.transform || this.defaultTransform,
            
            // Mapping configuration
            mapping: config.mapping || {},
            
            // JSON Path or XPath expressions
            paths: config.paths || {},
            
            // Value transformations
            valueTransforms: config.valueTransforms || {}
        };
        
        this.transformers.set(name, transformer);
        return transformer;
    }

    // Register aggregator
    registerAggregator(name, config) {
        const aggregator = {
            name: name,
            type: config.type || 'parallel', // parallel, sequential, conditional
            
            // Aggregation strategy
            strategy: config.strategy || 'merge', // merge, chain, select, custom
            
            // Requests to aggregate
            requests: config.requests || [],
            
            // Custom aggregation function
            aggregate: config.aggregate || this.defaultAggregate,
            
            // Error handling
            errorHandling: config.errorHandling || 'fail', // fail, partial, fallback
            
            // Timeout for aggregation
            timeout: config.timeout || this.config.timeout
        };
        
        this.aggregators.set(name, aggregator);
        return aggregator;
    }

    // Register validator
    registerValidator(name, schema) {
        this.validators.set(name, schema);
        return schema;
    }

    // Process API request
    async processRequest(req, res, next) {
        const key = `${req.method}:${req.path}:${req.headers['api-version'] || 'v1'}`;
        const route = this.routes.get(key);
        
        if (!route) {
            return next(); // Pass to next handler
        }
        
        this.stats.requests++;
        
        try {
            // Check authentication
            if (route.auth.required && !this.checkAuth(req, route.auth)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            
            // Validate request
            if (route.requestSchema) {
                const validation = this.validateRequest(req, route.requestSchema);
                if (!validation.valid) {
                    this.stats.validationErrors++;
                    return res.status(400).json({
                        error: 'Validation failed',
                        details: validation.errors
                    });
                }
            }
            
            // Check for mock response
            if (this.config.enableMocking && route.mock) {
                this.stats.mockResponses++;
                return this.sendMockResponse(res, route.mock);
            }
            
            // Transform request
            let transformedRequest = req;
            if (this.config.enableTransformation && route.requestTransform) {
                transformedRequest = await this.transformRequest(req, route.requestTransform);
                this.stats.transformations++;
            }
            
            // Process based on route type
            let response;
            if (route.aggregation && this.config.enableAggregation) {
                // Aggregate multiple backend calls
                response = await this.aggregateRequests(transformedRequest, route);
                this.stats.aggregations++;
            } else if (route.backend) {
                // Single backend call
                response = await this.callBackend(transformedRequest, route.backend);
            } else {
                // No backend configured
                return res.status(501).json({ error: 'No backend configured' });
            }
            
            // Transform response
            if (this.config.enableTransformation && route.responseTransform) {
                response = await this.transformResponse(response, route.responseTransform);
                this.stats.transformations++;
            }
            
            // Validate response
            if (route.responseSchema) {
                const validation = this.validateResponse(response, route.responseSchema);
                if (!validation.valid) {
                    this.logger.error(`Response validation failed: ${JSON.stringify(validation.errors)}`);
                    // Log but don't fail the request
                }
            }
            
            // Send response
            this.sendResponse(res, response, route);
            
        } catch (error) {
            this.logger.error(`API Gateway error: ${error.message}`);
            res.status(500).json({
                error: 'Internal server error',
                message: error.message
            });
        }
    }

    // Check authentication
    checkAuth(req, authConfig) {
        switch (authConfig.type) {
            case 'apikey':
                return req.headers['x-api-key'] === authConfig.key;
            case 'bearer':
                return req.headers.authorization?.startsWith('Bearer ');
            case 'basic':
                return req.headers.authorization?.startsWith('Basic ');
            case 'custom':
                return authConfig.check(req);
            default:
                return true;
        }
    }

    // Validate request
    validateRequest(req, schema) {
        // Implementation would use JSON Schema or similar
        return { valid: true, errors: [] };
    }

    // Validate response
    validateResponse(response, schema) {
        // Implementation would use JSON Schema or similar
        return { valid: true, errors: [] };
    }

    // Transform request
    async transformRequest(req, transformConfig) {
        const transformer = this.transformers.get(transformConfig);
        if (!transformer) return req;
        
        const transformed = {
            ...req,
            body: await this.applyTransformation(req.body, transformer),
            headers: { ...req.headers },
            query: { ...req.query }
        };
        
        // Apply header transformations
        if (transformer.mapping.headers) {
            for (const [key, value] of Object.entries(transformer.mapping.headers)) {
                transformed.headers[key] = this.resolveValue(value, req);
            }
        }
        
        // Apply query transformations
        if (transformer.mapping.query) {
            for (const [key, value] of Object.entries(transformer.mapping.query)) {
                transformed.query[key] = this.resolveValue(value, req);
            }
        }
        
        return transformed;
    }

    // Transform response
    async transformResponse(response, transformConfig) {
        const transformer = this.transformers.get(transformConfig);
        if (!transformer) return response;
        
        return await this.applyTransformation(response, transformer);
    }

    // Apply transformation
    async applyTransformation(data, transformer) {
        if (transformer.transform) {
            return await transformer.transform(data, transformer);
        }
        
        return this.defaultTransform(data, transformer);
    }

    // Default transformation
    defaultTransform(data, transformer) {
        let result = {};
        
        // Apply mapping rules
        for (const rule of transformer.rules) {
            switch (rule.type) {
                case 'copy':
                    result[rule.to] = jsonpath.query(data, rule.from)[0];
                    break;
                case 'rename':
                    result[rule.to] = data[rule.from];
                    delete data[rule.from];
                    break;
                case 'remove':
                    delete data[rule.field];
                    break;
                case 'add':
                    result[rule.field] = rule.value;
                    break;
                case 'transform':
                    result[rule.field] = this.applyValueTransform(
                        jsonpath.query(data, rule.from)[0],
                        rule.transform
                    );
                    break;
                case 'merge':
                    result = { ...result, ...data };
                    break;
            }
        }
        
        // Apply JSON Path mappings
        for (const [key, path] of Object.entries(transformer.paths)) {
            const value = jsonpath.query(data, path);
            if (value.length > 0) {
                result[key] = value.length === 1 ? value[0] : value;
            }
        }
        
        return result;
    }

    // Apply value transformation
    applyValueTransform(value, transform) {
        switch (transform.type) {
            case 'uppercase':
                return String(value).toUpperCase();
            case 'lowercase':
                return String(value).toLowerCase();
            case 'number':
                return Number(value);
            case 'string':
                return String(value);
            case 'boolean':
                return Boolean(value);
            case 'date':
                return new Date(value).toISOString();
            case 'base64':
                return Buffer.from(value).toString('base64');
            case 'hash':
                return crypto.createHash(transform.algorithm || 'sha256')
                    .update(String(value))
                    .digest('hex');
            case 'custom':
                return transform.fn(value);
            default:
                return value;
        }
    }

    // Resolve value from request context
    resolveValue(value, req) {
        if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
            const path = value.slice(2, -1);
            const parts = path.split('.');
            
            let result = req;
            for (const part of parts) {
                result = result[part];
                if (result === undefined) break;
            }
            
            return result;
        }
        
        return value;
    }

    // Aggregate requests
    async aggregateRequests(req, route) {
        const aggregator = this.aggregators.get(route.id);
        if (!aggregator) {
            throw new Error('Aggregator not found');
        }
        
        const results = [];
        
        if (aggregator.type === 'parallel') {
            // Execute requests in parallel
            const promises = aggregator.requests.map(request => 
                this.executeAggregatedRequest(req, request)
            );
            
            const responses = await Promise.allSettled(promises);
            
            for (let i = 0; i < responses.length; i++) {
                if (responses[i].status === 'fulfilled') {
                    results.push(responses[i].value);
                } else if (aggregator.errorHandling === 'fail') {
                    throw responses[i].reason;
                } else {
                    results.push({ error: responses[i].reason.message });
                }
            }
        } else if (aggregator.type === 'sequential') {
            // Execute requests sequentially
            for (const request of aggregator.requests) {
                try {
                    const response = await this.executeAggregatedRequest(req, request);
                    results.push(response);
                    
                    // Pass response to next request if chaining
                    if (aggregator.strategy === 'chain') {
                        req = { ...req, previousResponse: response };
                    }
                } catch (error) {
                    if (aggregator.errorHandling === 'fail') {
                        throw error;
                    }
                    results.push({ error: error.message });
                }
            }
        }
        
        // Aggregate results
        return aggregator.aggregate(results, aggregator);
    }

    // Execute aggregated request
    async executeAggregatedRequest(req, requestConfig) {
        const backend = requestConfig.backend || requestConfig.url;
        
        // Build request
        const request = {
            method: requestConfig.method || 'GET',
            url: backend + (requestConfig.path || ''),
            headers: { ...req.headers, ...(requestConfig.headers || {}) },
            data: requestConfig.body || req.body,
            params: requestConfig.query || req.query
        };
        
        // Apply request-specific transformations
        if (requestConfig.transform) {
            const transformer = this.transformers.get(requestConfig.transform);
            if (transformer) {
                request.data = await this.applyTransformation(request.data, transformer);
            }
        }
        
        // Make HTTP request
        const axios = require('axios');
        const response = await axios(request);
        
        return response.data;
    }

    // Default aggregation
    defaultAggregate(results, aggregator) {
        switch (aggregator.strategy) {
            case 'merge':
                // Merge all results into single object
                return results.reduce((acc, result) => ({ ...acc, ...result }), {});
            
            case 'array':
                // Return as array
                return results;
            
            case 'select':
                // Select first successful result
                return results.find(r => !r.error) || results[0];
            
            case 'chain':
                // Return last result in chain
                return results[results.length - 1];
            
            default:
                return results;
        }
    }

    // Call backend
    async callBackend(req, backend) {
        const axios = require('axios');
        
        const request = {
            method: req.method,
            url: backend + req.path,
            headers: req.headers,
            data: req.body,
            params: req.query,
            timeout: this.config.timeout
        };
        
        // Apply retry policy
        let lastError;
        for (let i = 0; i <= this.config.retryPolicy.retries; i++) {
            try {
                const response = await axios(request);
                return response.data;
            } catch (error) {
                lastError = error;
                
                if (i < this.config.retryPolicy.retries) {
                    // Calculate backoff
                    const delay = this.config.retryPolicy.backoff === 'exponential'
                        ? Math.pow(2, i) * 1000
                        : (i + 1) * 1000;
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        throw lastError;
    }

    // Send mock response
    sendMockResponse(res, mockConfig) {
        const status = mockConfig.status || 200;
        const headers = mockConfig.headers || {};
        const body = mockConfig.body || {};
        
        // Add delay if specified
        if (mockConfig.delay) {
            setTimeout(() => {
                res.status(status).set(headers).json(body);
            }, mockConfig.delay);
        } else {
            res.status(status).set(headers).json(body);
        }
    }

    // Send response
    sendResponse(res, data, route) {
        // Set cache headers if caching is enabled
        if (route.cache.enabled) {
            res.set({
                'Cache-Control': `public, max-age=${route.cache.duration}`,
                'ETag': crypto.createHash('md5').update(JSON.stringify(data)).digest('hex')
            });
        }
        
        // Set CORS headers if enabled
        if (route.cors) {
            res.set({
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
        }
        
        res.json(data);
    }

    // Add request interceptor
    addRequestInterceptor(interceptor) {
        this.requestInterceptors.push(interceptor);
    }

    // Add response interceptor
    addResponseInterceptor(interceptor) {
        this.responseInterceptors.push(interceptor);
    }

    // Generate API documentation
    generateDocumentation() {
        const docs = {
            openapi: '3.0.0',
            info: {
                title: 'API Gateway',
                version: '1.0.0',
                description: 'Unified API Gateway'
            },
            paths: {}
        };
        
        for (const [key, route] of this.routes) {
            const [method, path, version] = key.split(':');
            
            if (!docs.paths[path]) {
                docs.paths[path] = {};
            }
            
            docs.paths[path][method.toLowerCase()] = {
                summary: route.description,
                tags: route.tags,
                parameters: [],
                responses: {
                    '200': {
                        description: 'Successful response'
                    }
                }
            };
        }
        
        return docs;
    }

    // Get statistics
    getStats() {
        return {
            routes: this.routes.size,
            transformers: this.transformers.size,
            aggregators: this.aggregators.size,
            validators: this.validators.size,
            requests: this.stats.requests,
            transformations: this.stats.transformations,
            aggregations: this.stats.aggregations,
            validationErrors: this.stats.validationErrors,
            mockResponses: this.stats.mockResponses
        };
    }
}

module.exports = APIGateway;