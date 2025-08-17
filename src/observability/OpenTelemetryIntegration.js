const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { 
    BasicTracerProvider, 
    BatchSpanProcessor, 
    ConsoleSpanExporter 
} = require('@opentelemetry/tracing');
const { 
    MeterProvider, 
    PeriodicExportingMetricReader,
    ConsoleMetricExporter
} = require('@opentelemetry/sdk-metrics');
const opentelemetry = require('@opentelemetry/api');
const Logger = require('../utils/Logger');

class OpenTelemetryIntegration {
    constructor(options = {}) {
        this.logger = new Logger();
        
        // Configuration
        this.config = {
            serviceName: options.serviceName || 'rawrproxy',
            serviceVersion: options.serviceVersion || '2.0.0',
            environment: options.environment || process.env.NODE_ENV || 'production',
            
            // Tracing configuration
            tracing: {
                enabled: options.tracing?.enabled !== false,
                jaegerEndpoint: options.tracing?.jaegerEndpoint || 'http://localhost:14268/api/traces',
                samplingRate: options.tracing?.samplingRate || 1.0,
                consoleExport: options.tracing?.consoleExport || false
            },
            
            // Metrics configuration
            metrics: {
                enabled: options.metrics?.enabled !== false,
                prometheusPort: options.metrics?.prometheusPort || 9464,
                consoleExport: options.metrics?.consoleExport || false,
                interval: options.metrics?.interval || 60000
            },
            
            // Auto-instrumentation
            autoInstrument: {
                enabled: options.autoInstrument?.enabled !== false,
                http: options.autoInstrument?.http !== false,
                express: options.autoInstrument?.express !== false,
                redis: options.autoInstrument?.redis !== false,
                dns: options.autoInstrument?.dns !== false,
                fs: options.autoInstrument?.fs || false
            },
            
            // Custom attributes
            attributes: options.attributes || {}
        };
        
        // SDK components
        this.sdk = null;
        this.tracer = null;
        this.meter = null;
        this.resource = null;
        
        // Active spans storage
        this.activeSpans = new Map();
        
        // Custom metrics
        this.metrics = {
            requestCounter: null,
            requestDuration: null,
            activeConnections: null,
            errorCounter: null,
            backendLatency: null,
            cacheHits: null,
            cacheMisses: null,
            wsConnections: null,
            grpcCalls: null
        };
        
        // Statistics
        this.stats = {
            spansCreated: 0,
            spansEnded: 0,
            metricsRecorded: 0,
            errors: 0
        };
        
        this.logger.info('OpenTelemetry integration initialized');
    }

    // Initialize OpenTelemetry
    async initialize() {
        try {
            // Create resource
            this.resource = Resource.default().merge(
                new Resource({
                    [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
                    [SemanticResourceAttributes.SERVICE_VERSION]: this.config.serviceVersion,
                    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment,
                    ...this.config.attributes
                })
            );
            
            // Initialize tracing
            if (this.config.tracing.enabled) {
                await this.initializeTracing();
            }
            
            // Initialize metrics
            if (this.config.metrics.enabled) {
                await this.initializeMetrics();
            }
            
            // Initialize auto-instrumentation
            if (this.config.autoInstrument.enabled) {
                this.initializeAutoInstrumentation();
            }
            
            this.logger.info('OpenTelemetry initialized successfully');
            return true;
        } catch (error) {
            this.logger.error(`Failed to initialize OpenTelemetry: ${error.message}`);
            return false;
        }
    }

    // Initialize tracing
    async initializeTracing() {
        // Create Jaeger exporter
        const jaegerExporter = new JaegerExporter({
            endpoint: this.config.tracing.jaegerEndpoint
        });
        
        // Create tracer provider
        const tracerProvider = new BasicTracerProvider({
            resource: this.resource,
            sampler: {
                shouldSample: () => ({
                    decision: Math.random() < this.config.tracing.samplingRate ? 1 : 0
                })
            }
        });
        
        // Add span processors
        tracerProvider.addSpanProcessor(new BatchSpanProcessor(jaegerExporter));
        
        if (this.config.tracing.consoleExport) {
            tracerProvider.addSpanProcessor(new BatchSpanProcessor(new ConsoleSpanExporter()));
        }
        
        // Register tracer provider
        tracerProvider.register();
        
        // Get tracer
        this.tracer = opentelemetry.trace.getTracer(
            this.config.serviceName,
            this.config.serviceVersion
        );
        
        this.logger.info('Tracing initialized with Jaeger exporter');
    }

    // Initialize metrics
    async initializeMetrics() {
        // Create Prometheus exporter
        const prometheusExporter = new PrometheusExporter(
            {
                port: this.config.metrics.prometheusPort,
                endpoint: '/metrics'
            },
            () => {
                this.logger.info(`Prometheus metrics server started on port ${this.config.metrics.prometheusPort}`);
            }
        );
        
        // Create meter provider
        const meterProvider = new MeterProvider({
            resource: this.resource,
            readers: [prometheusExporter]
        });
        
        // Add console exporter if enabled
        if (this.config.metrics.consoleExport) {
            meterProvider.addMetricReader(
                new PeriodicExportingMetricReader({
                    exporter: new ConsoleMetricExporter(),
                    exportIntervalMillis: this.config.metrics.interval
                })
            );
        }
        
        // Register meter provider
        opentelemetry.metrics.setGlobalMeterProvider(meterProvider);
        
        // Get meter
        this.meter = opentelemetry.metrics.getMeter(
            this.config.serviceName,
            this.config.serviceVersion
        );
        
        // Create custom metrics
        this.createCustomMetrics();
        
        this.logger.info('Metrics initialized with Prometheus exporter');
    }

    // Create custom metrics
    createCustomMetrics() {
        // Request counter
        this.metrics.requestCounter = this.meter.createCounter('http_requests_total', {
            description: 'Total number of HTTP requests',
            unit: '1'
        });
        
        // Request duration histogram
        this.metrics.requestDuration = this.meter.createHistogram('http_request_duration_ms', {
            description: 'HTTP request duration in milliseconds',
            unit: 'ms'
        });
        
        // Active connections gauge
        this.metrics.activeConnections = this.meter.createUpDownCounter('active_connections', {
            description: 'Number of active connections',
            unit: '1'
        });
        
        // Error counter
        this.metrics.errorCounter = this.meter.createCounter('errors_total', {
            description: 'Total number of errors',
            unit: '1'
        });
        
        // Backend latency histogram
        this.metrics.backendLatency = this.meter.createHistogram('backend_latency_ms', {
            description: 'Backend response latency in milliseconds',
            unit: 'ms'
        });
        
        // Cache metrics
        this.metrics.cacheHits = this.meter.createCounter('cache_hits_total', {
            description: 'Total number of cache hits',
            unit: '1'
        });
        
        this.metrics.cacheMisses = this.meter.createCounter('cache_misses_total', {
            description: 'Total number of cache misses',
            unit: '1'
        });
        
        // WebSocket connections
        this.metrics.wsConnections = this.meter.createUpDownCounter('websocket_connections', {
            description: 'Number of active WebSocket connections',
            unit: '1'
        });
        
        // gRPC calls
        this.metrics.grpcCalls = this.meter.createCounter('grpc_calls_total', {
            description: 'Total number of gRPC calls',
            unit: '1'
        });
    }

    // Initialize auto-instrumentation
    initializeAutoInstrumentation() {
        const instrumentations = [];
        
        if (this.config.autoInstrument.http) {
            instrumentations.push('@opentelemetry/instrumentation-http');
        }
        
        if (this.config.autoInstrument.express) {
            instrumentations.push('@opentelemetry/instrumentation-express');
        }
        
        if (this.config.autoInstrument.redis) {
            instrumentations.push('@opentelemetry/instrumentation-redis');
            instrumentations.push('@opentelemetry/instrumentation-ioredis');
        }
        
        if (this.config.autoInstrument.dns) {
            instrumentations.push('@opentelemetry/instrumentation-dns');
        }
        
        if (this.config.autoInstrument.fs) {
            instrumentations.push('@opentelemetry/instrumentation-fs');
        }
        
        // Register instrumentations
        const sdk = new NodeSDK({
            resource: this.resource,
            instrumentations: getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-fs': {
                    enabled: this.config.autoInstrument.fs
                }
            })
        });
        
        sdk.start();
        this.sdk = sdk;
        
        this.logger.info('Auto-instrumentation enabled');
    }

    // Create a new span
    createSpan(name, options = {}) {
        if (!this.tracer) return null;
        
        const span = this.tracer.startSpan(name, {
            kind: options.kind || opentelemetry.SpanKind.INTERNAL,
            attributes: options.attributes || {},
            links: options.links || []
        });
        
        // Store active span
        const spanId = span.spanContext().spanId;
        this.activeSpans.set(spanId, span);
        
        this.stats.spansCreated++;
        
        return span;
    }

    // Create HTTP span
    createHttpSpan(req, res) {
        if (!this.tracer) return null;
        
        const span = this.createSpan(`${req.method} ${req.path}`, {
            kind: opentelemetry.SpanKind.SERVER,
            attributes: {
                'http.method': req.method,
                'http.url': req.url,
                'http.target': req.path,
                'http.host': req.hostname,
                'http.scheme': req.protocol,
                'http.user_agent': req.headers['user-agent'],
                'net.peer.ip': req.ip
            }
        });
        
        // Add response attributes when response ends
        if (span && res) {
            const originalEnd = res.end;
            res.end = function(...args) {
                span.setAttributes({
                    'http.status_code': res.statusCode,
                    'http.response_size': res.get('content-length') || 0
                });
                
                if (res.statusCode >= 400) {
                    span.setStatus({
                        code: opentelemetry.SpanStatusCode.ERROR,
                        message: `HTTP ${res.statusCode}`
                    });
                }
                
                span.end();
                return originalEnd.apply(res, args);
            };
        }
        
        return span;
    }

    // Create backend span
    createBackendSpan(backend, method = 'GET') {
        if (!this.tracer) return null;
        
        return this.createSpan(`Backend ${method} ${backend}`, {
            kind: opentelemetry.SpanKind.CLIENT,
            attributes: {
                'backend.url': backend,
                'backend.method': method
            }
        });
    }

    // Add event to span
    addSpanEvent(span, name, attributes = {}) {
        if (!span) return;
        
        span.addEvent(name, attributes, Date.now());
    }

    // Set span error
    setSpanError(span, error) {
        if (!span) return;
        
        span.recordException(error);
        span.setStatus({
            code: opentelemetry.SpanStatusCode.ERROR,
            message: error.message
        });
        
        this.stats.errors++;
    }

    // End span
    endSpan(span) {
        if (!span) return;
        
        span.end();
        
        const spanId = span.spanContext().spanId;
        this.activeSpans.delete(spanId);
        
        this.stats.spansEnded++;
    }

    // Record HTTP request metric
    recordHttpRequest(method, path, statusCode, duration) {
        if (!this.metrics.requestCounter) return;
        
        const labels = {
            method: method,
            path: path,
            status: statusCode.toString()
        };
        
        this.metrics.requestCounter.add(1, labels);
        this.metrics.requestDuration.record(duration, labels);
        
        if (statusCode >= 400) {
            this.metrics.errorCounter.add(1, { type: 'http', status: statusCode.toString() });
        }
        
        this.stats.metricsRecorded++;
    }

    // Record backend latency
    recordBackendLatency(backend, duration, success = true) {
        if (!this.metrics.backendLatency) return;
        
        this.metrics.backendLatency.record(duration, {
            backend: backend,
            success: success.toString()
        });
        
        if (!success) {
            this.metrics.errorCounter.add(1, { type: 'backend', backend: backend });
        }
        
        this.stats.metricsRecorded++;
    }

    // Record cache metrics
    recordCacheHit(cacheType = 'default') {
        if (this.metrics.cacheHits) {
            this.metrics.cacheHits.add(1, { type: cacheType });
            this.stats.metricsRecorded++;
        }
    }

    recordCacheMiss(cacheType = 'default') {
        if (this.metrics.cacheMisses) {
            this.metrics.cacheMisses.add(1, { type: cacheType });
            this.stats.metricsRecorded++;
        }
    }

    // Update connection metrics
    incrementConnections() {
        if (this.metrics.activeConnections) {
            this.metrics.activeConnections.add(1);
        }
    }

    decrementConnections() {
        if (this.metrics.activeConnections) {
            this.metrics.activeConnections.add(-1);
        }
    }

    // Update WebSocket metrics
    incrementWsConnections() {
        if (this.metrics.wsConnections) {
            this.metrics.wsConnections.add(1);
        }
    }

    decrementWsConnections() {
        if (this.metrics.wsConnections) {
            this.metrics.wsConnections.add(-1);
        }
    }

    // Record gRPC call
    recordGrpcCall(method, success = true) {
        if (this.metrics.grpcCalls) {
            this.metrics.grpcCalls.add(1, {
                method: method,
                success: success.toString()
            });
            this.stats.metricsRecorded++;
        }
    }

    // Create baggage
    createBaggage(key, value) {
        const baggage = opentelemetry.propagation.getBaggage(opentelemetry.context.active());
        return baggage ? baggage.setEntry(key, { value }) : null;
    }

    // Get baggage value
    getBaggageValue(key) {
        const baggage = opentelemetry.propagation.getBaggage(opentelemetry.context.active());
        const entry = baggage ? baggage.getEntry(key) : null;
        return entry ? entry.value : null;
    }

    // Inject context into headers
    injectContext(headers) {
        const propagator = opentelemetry.propagation;
        propagator.inject(opentelemetry.context.active(), headers);
        return headers;
    }

    // Extract context from headers
    extractContext(headers) {
        const propagator = opentelemetry.propagation;
        return propagator.extract(opentelemetry.context.active(), headers);
    }

    // Express middleware
    middleware() {
        return (req, res, next) => {
            // Extract context from incoming request
            const context = this.extractContext(req.headers);
            
            // Run the rest of the request in the extracted context
            opentelemetry.context.with(context, () => {
                // Create span for this request
                const span = this.createHttpSpan(req, res);
                
                // Store span in request for later use
                req.span = span;
                
                // Track request start time
                req.startTime = Date.now();
                
                // Increment active connections
                this.incrementConnections();
                
                // Hook into response end
                const originalEnd = res.end;
                res.end = function(...args) {
                    // Calculate duration
                    const duration = Date.now() - req.startTime;
                    
                    // Record metrics
                    this.recordHttpRequest(req.method, req.path, res.statusCode, duration);
                    
                    // Decrement active connections
                    this.decrementConnections();
                    
                    // End span if not already ended
                    if (span && !span.ended) {
                        this.endSpan(span);
                    }
                    
                    return originalEnd.apply(res, args);
                }.bind(this);
                
                next();
            });
        };
    }

    // Create custom span middleware
    spanMiddleware(spanName) {
        return (req, res, next) => {
            const parentSpan = req.span;
            const context = parentSpan ? 
                opentelemetry.trace.setSpan(opentelemetry.context.active(), parentSpan) :
                opentelemetry.context.active();
            
            opentelemetry.context.with(context, () => {
                const span = this.createSpan(spanName, {
                    kind: opentelemetry.SpanKind.INTERNAL
                });
                
                req.customSpan = span;
                
                next();
                
                if (span) {
                    this.endSpan(span);
                }
            });
        };
    }

    // Wrap async function with span
    wrapWithSpan(name, fn, options = {}) {
        return async (...args) => {
            const span = this.createSpan(name, options);
            
            try {
                const result = await fn(...args);
                
                if (span) {
                    span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
                    this.endSpan(span);
                }
                
                return result;
            } catch (error) {
                if (span) {
                    this.setSpanError(span, error);
                    this.endSpan(span);
                }
                throw error;
            }
        };
    }

    // Get statistics
    getStats() {
        return {
            spans: {
                created: this.stats.spansCreated,
                ended: this.stats.spansEnded,
                active: this.activeSpans.size
            },
            metrics: {
                recorded: this.stats.metricsRecorded
            },
            errors: this.stats.errors,
            config: {
                tracingEnabled: this.config.tracing.enabled,
                metricsEnabled: this.config.metrics.enabled,
                autoInstrumentEnabled: this.config.autoInstrument.enabled
            }
        };
    }

    // Shutdown
    async shutdown() {
        try {
            // Flush and shutdown SDK
            if (this.sdk) {
                await this.sdk.shutdown();
            }
            
            // End all active spans
            for (const [id, span] of this.activeSpans) {
                this.endSpan(span);
            }
            
            this.logger.info('OpenTelemetry shut down successfully');
        } catch (error) {
            this.logger.error(`Error shutting down OpenTelemetry: ${error.message}`);
        }
    }
}

module.exports = OpenTelemetryIntegration;