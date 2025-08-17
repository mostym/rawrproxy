const client = require('prom-client');
const Logger = require('../utils/Logger');

class MetricsCollector {
    constructor() {
        this.logger = new Logger();
        this.register = new client.Registry();
        
        // Add default metrics (CPU, memory, etc.)
        client.collectDefaultMetrics({ 
            register: this.register,
            prefix: 'rawrproxy_'
        });

        // HTTP metrics
        this.httpRequestDuration = new client.Histogram({
            name: 'rawrproxy_http_request_duration_seconds',
            help: 'Duration of HTTP requests in seconds',
            labelNames: ['method', 'route', 'status_code', 'backend'],
            buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
        });

        this.httpRequestTotal = new client.Counter({
            name: 'rawrproxy_http_requests_total',
            help: 'Total number of HTTP requests',
            labelNames: ['method', 'route', 'status_code', 'backend']
        });

        this.httpRequestSize = new client.Histogram({
            name: 'rawrproxy_http_request_size_bytes',
            help: 'Size of HTTP requests in bytes',
            labelNames: ['method', 'route', 'backend'],
            buckets: [100, 1000, 10000, 100000, 1000000, 10000000]
        });

        this.httpResponseSize = new client.Histogram({
            name: 'rawrproxy_http_response_size_bytes',
            help: 'Size of HTTP responses in bytes',
            labelNames: ['method', 'route', 'backend'],
            buckets: [100, 1000, 10000, 100000, 1000000, 10000000]
        });

        // WebSocket metrics
        this.wsConnectionsActive = new client.Gauge({
            name: 'rawrproxy_websocket_connections_active',
            help: 'Number of active WebSocket connections',
            labelNames: ['backend', 'domain']
        });

        this.wsConnectionsTotal = new client.Counter({
            name: 'rawrproxy_websocket_connections_total',
            help: 'Total number of WebSocket connections',
            labelNames: ['backend', 'domain', 'status']
        });

        this.wsMessagesSent = new client.Counter({
            name: 'rawrproxy_websocket_messages_sent_total',
            help: 'Total number of WebSocket messages sent',
            labelNames: ['backend', 'domain', 'direction']
        });

        this.wsBytesTransferred = new client.Counter({
            name: 'rawrproxy_websocket_bytes_transferred_total',
            help: 'Total bytes transferred over WebSocket',
            labelNames: ['backend', 'domain', 'direction']
        });

        // Backend metrics
        this.backendHealth = new client.Gauge({
            name: 'rawrproxy_backend_health',
            help: 'Backend health status (1 = healthy, 0 = unhealthy)',
            labelNames: ['backend', 'url']
        });

        this.backendResponseTime = new client.Histogram({
            name: 'rawrproxy_backend_response_time_seconds',
            help: 'Backend response time in seconds',
            labelNames: ['backend', 'url'],
            buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
        });

        this.backendRequestsInFlight = new client.Gauge({
            name: 'rawrproxy_backend_requests_in_flight',
            help: 'Number of requests currently being processed by backend',
            labelNames: ['backend', 'url']
        });

        // Cache metrics
        this.cacheHits = new client.Counter({
            name: 'rawrproxy_cache_hits_total',
            help: 'Total number of cache hits',
            labelNames: ['cache_type']
        });

        this.cacheMisses = new client.Counter({
            name: 'rawrproxy_cache_misses_total',
            help: 'Total number of cache misses',
            labelNames: ['cache_type']
        });

        this.cacheSize = new client.Gauge({
            name: 'rawrproxy_cache_size_bytes',
            help: 'Current cache size in bytes',
            labelNames: ['cache_type']
        });

        // Rate limiting metrics
        this.rateLimitHits = new client.Counter({
            name: 'rawrproxy_rate_limit_hits_total',
            help: 'Total number of rate limit hits',
            labelNames: ['identifier', 'limit_type']
        });

        this.rateLimitRejections = new client.Counter({
            name: 'rawrproxy_rate_limit_rejections_total',
            help: 'Total number of requests rejected due to rate limiting',
            labelNames: ['identifier', 'limit_type']
        });

        // Circuit breaker metrics
        this.circuitBreakerState = new client.Gauge({
            name: 'rawrproxy_circuit_breaker_state',
            help: 'Circuit breaker state (0 = closed, 1 = open, 2 = half-open)',
            labelNames: ['backend', 'service']
        });

        this.circuitBreakerTrips = new client.Counter({
            name: 'rawrproxy_circuit_breaker_trips_total',
            help: 'Total number of circuit breaker trips',
            labelNames: ['backend', 'service']
        });

        // Error metrics
        this.errors = new client.Counter({
            name: 'rawrproxy_errors_total',
            help: 'Total number of errors',
            labelNames: ['error_type', 'backend', 'domain']
        });

        // System metrics
        this.uptime = new client.Gauge({
            name: 'rawrproxy_uptime_seconds',
            help: 'Proxy server uptime in seconds'
        });

        // Register all metrics
        this.register.registerMetric(this.httpRequestDuration);
        this.register.registerMetric(this.httpRequestTotal);
        this.register.registerMetric(this.httpRequestSize);
        this.register.registerMetric(this.httpResponseSize);
        this.register.registerMetric(this.wsConnectionsActive);
        this.register.registerMetric(this.wsConnectionsTotal);
        this.register.registerMetric(this.wsMessagesSent);
        this.register.registerMetric(this.wsBytesTransferred);
        this.register.registerMetric(this.backendHealth);
        this.register.registerMetric(this.backendResponseTime);
        this.register.registerMetric(this.backendRequestsInFlight);
        this.register.registerMetric(this.cacheHits);
        this.register.registerMetric(this.cacheMisses);
        this.register.registerMetric(this.cacheSize);
        this.register.registerMetric(this.rateLimitHits);
        this.register.registerMetric(this.rateLimitRejections);
        this.register.registerMetric(this.circuitBreakerState);
        this.register.registerMetric(this.circuitBreakerTrips);
        this.register.registerMetric(this.errors);
        this.register.registerMetric(this.uptime);

        // Start uptime tracking
        this.startTime = Date.now();
        setInterval(() => {
            this.uptime.set((Date.now() - this.startTime) / 1000);
        }, 10000);

        this.logger.info('Metrics collector initialized');
    }

    // Record HTTP request
    recordHttpRequest(method, route, statusCode, backend, duration, requestSize, responseSize) {
        const labels = { 
            method, 
            route: this.normalizeRoute(route), 
            status_code: statusCode.toString(), 
            backend: backend || 'unknown' 
        };
        
        this.httpRequestTotal.inc(labels);
        this.httpRequestDuration.observe(labels, duration);
        
        if (requestSize) {
            this.httpRequestSize.observe(
                { method, route: this.normalizeRoute(route), backend: backend || 'unknown' },
                requestSize
            );
        }
        
        if (responseSize) {
            this.httpResponseSize.observe(
                { method, route: this.normalizeRoute(route), backend: backend || 'unknown' },
                responseSize
            );
        }
    }

    // Record WebSocket connection
    recordWsConnection(backend, domain, status = 'established') {
        this.wsConnectionsTotal.inc({ backend, domain, status });
        if (status === 'established') {
            this.wsConnectionsActive.inc({ backend, domain });
        }
    }

    recordWsDisconnection(backend, domain) {
        this.wsConnectionsActive.dec({ backend, domain });
    }

    recordWsMessage(backend, domain, direction, bytes) {
        this.wsMessagesSent.inc({ backend, domain, direction });
        if (bytes) {
            this.wsBytesTransferred.inc({ backend, domain, direction }, bytes);
        }
    }

    // Record backend health
    setBackendHealth(backend, url, isHealthy) {
        this.backendHealth.set({ backend, url }, isHealthy ? 1 : 0);
    }

    recordBackendResponse(backend, url, responseTime) {
        this.backendResponseTime.observe({ backend, url }, responseTime);
    }

    setBackendRequestsInFlight(backend, url, count) {
        this.backendRequestsInFlight.set({ backend, url }, count);
    }

    // Record cache operations
    recordCacheHit(cacheType = 'memory') {
        this.cacheHits.inc({ cache_type: cacheType });
    }

    recordCacheMiss(cacheType = 'memory') {
        this.cacheMisses.inc({ cache_type: cacheType });
    }

    setCacheSize(cacheType, sizeBytes) {
        this.cacheSize.set({ cache_type: cacheType }, sizeBytes);
    }

    // Record rate limiting
    recordRateLimitHit(identifier, limitType = 'ip') {
        this.rateLimitHits.inc({ identifier, limit_type: limitType });
    }

    recordRateLimitRejection(identifier, limitType = 'ip') {
        this.rateLimitRejections.inc({ identifier, limit_type: limitType });
    }

    // Circuit breaker metrics
    setCircuitBreakerState(backend, service, state) {
        // 0 = closed, 1 = open, 2 = half-open
        const stateValue = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
        this.circuitBreakerState.set({ backend, service }, stateValue);
    }

    recordCircuitBreakerTrip(backend, service) {
        this.circuitBreakerTrips.inc({ backend, service });
    }

    // Record errors
    recordError(errorType, backend = 'unknown', domain = 'unknown') {
        this.errors.inc({ error_type: errorType, backend, domain });
    }

    // Middleware for Express
    middleware() {
        return (req, res, next) => {
            const startTime = Date.now();
            const requestSize = parseInt(req.get('content-length') || 0);

            // Intercept response end
            const originalEnd = res.end;
            res.end = (...args) => {
                const duration = (Date.now() - startTime) / 1000;
                const responseSize = parseInt(res.get('content-length') || 0);
                const backend = res.get('x-proxy-backend') || 'direct';
                
                this.recordHttpRequest(
                    req.method,
                    req.route?.path || req.path,
                    res.statusCode,
                    backend,
                    duration,
                    requestSize,
                    responseSize
                );

                originalEnd.apply(res, args);
            };

            next();
        };
    }

    // Get metrics in Prometheus format
    async getMetrics() {
        return await this.register.metrics();
    }

    // Get metrics content type
    getContentType() {
        return this.register.contentType;
    }

    // Normalize route paths for metrics
    normalizeRoute(route) {
        // Replace IDs and UUIDs with placeholders
        return route
            .replace(/\/\d+/g, '/:id')
            .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/:uuid')
            .replace(/\/[a-f0-9]{24}/g, '/:objectid');
    }

    // Reset all metrics (useful for testing)
    reset() {
        this.register.resetMetrics();
    }
}

module.exports = MetricsCollector;