const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const http2 = require('http2');
const { proxy } = require('http2-proxy');
const Logger = require('../utils/Logger');
const path = require('path');
const fs = require('fs');

class GrpcProxy {
    constructor(options = {}) {
        this.logger = new Logger();
        this.services = new Map();
        this.clients = new Map();
        this.protoCache = new Map();
        
        // Configuration
        this.config = {
            maxMessageSize: options.maxMessageSize || 4 * 1024 * 1024, // 4MB
            keepaliveTime: options.keepaliveTime || 120000, // 2 minutes
            keepaliveTimeout: options.keepaliveTimeout || 20000, // 20 seconds
            enableReflection: options.enableReflection !== false,
            protoPath: options.protoPath || './protos'
        };
        
        // Statistics
        this.stats = {
            requests: 0,
            responses: 0,
            errors: 0,
            activeStreams: 0,
            byMethod: new Map()
        };
        
        this.logger.info('gRPC proxy initialized');
    }

    // Register a gRPC service
    registerService(config) {
        const service = {
            name: config.name,
            backend: config.backend, // Backend gRPC server URL
            protoFile: config.protoFile, // Path to .proto file
            packageName: config.packageName,
            serviceName: config.serviceName,
            loadBalancing: config.loadBalancing || 'round_robin',
            healthCheck: config.healthCheck || null,
            middleware: config.middleware || [],
            retries: config.retries || 3,
            timeout: config.timeout || 30000,
            metadata: config.metadata || {} // Default metadata to add
        };
        
        // Load proto definition
        if (service.protoFile) {
            try {
                const packageDefinition = protoLoader.loadSync(service.protoFile, {
                    keepCase: true,
                    longs: String,
                    enums: String,
                    defaults: true,
                    oneofs: true
                });
                
                const proto = grpc.loadPackageDefinition(packageDefinition);
                service.proto = proto;
                
                // Navigate to the service definition
                let serviceDefinition = proto;
                if (service.packageName) {
                    const packages = service.packageName.split('.');
                    for (const pkg of packages) {
                        serviceDefinition = serviceDefinition[pkg];
                    }
                }
                service.serviceDefinition = serviceDefinition[service.serviceName];
                
                this.logger.info(`Loaded proto for service: ${service.name}`);
            } catch (error) {
                this.logger.error(`Failed to load proto for ${service.name}: ${error.message}`);
                return null;
            }
        }
        
        this.services.set(service.name, service);
        this.logger.info(`Registered gRPC service: ${service.name} -> ${service.backend}`);
        
        return service;
    }

    // Get or create gRPC client
    getClient(serviceName) {
        const service = this.services.get(serviceName);
        if (!service) {
            throw new Error(`Service not found: ${serviceName}`);
        }
        
        const cacheKey = `${serviceName}:${service.backend}`;
        
        if (this.clients.has(cacheKey)) {
            return this.clients.get(cacheKey);
        }
        
        // Create new client
        const credentials = service.backend.startsWith('https://') 
            ? grpc.credentials.createSsl()
            : grpc.credentials.createInsecure();
        
        const client = new service.serviceDefinition(
            service.backend.replace(/^https?:\/\//, ''),
            credentials,
            {
                'grpc.max_send_message_length': this.config.maxMessageSize,
                'grpc.max_receive_message_length': this.config.maxMessageSize,
                'grpc.keepalive_time_ms': this.config.keepaliveTime,
                'grpc.keepalive_timeout_ms': this.config.keepaliveTimeout
            }
        );
        
        this.clients.set(cacheKey, client);
        this.logger.info(`Created gRPC client for ${serviceName}`);
        
        return client;
    }

    // Proxy a gRPC call
    async proxyCall(serviceName, methodName, request, metadata = {}) {
        const service = this.services.get(serviceName);
        if (!service) {
            throw new Error(`Service not found: ${serviceName}`);
        }
        
        const client = this.getClient(serviceName);
        const method = client[methodName];
        
        if (!method) {
            throw new Error(`Method not found: ${methodName}`);
        }
        
        // Merge metadata
        const callMetadata = new grpc.Metadata();
        for (const [key, value] of Object.entries(service.metadata)) {
            callMetadata.add(key, value);
        }
        for (const [key, value] of Object.entries(metadata)) {
            callMetadata.add(key, value);
        }
        
        // Update statistics
        this.stats.requests++;
        const methodKey = `${serviceName}.${methodName}`;
        this.stats.byMethod.set(methodKey, (this.stats.byMethod.get(methodKey) || 0) + 1);
        
        return new Promise((resolve, reject) => {
            const deadline = new Date();
            deadline.setMilliseconds(deadline.getMilliseconds() + service.timeout);
            
            const options = {
                deadline: deadline
            };
            
            // Check if it's a streaming call
            const methodDefinition = client[methodName].requestStream || client[methodName].responseStream;
            
            if (methodDefinition) {
                // Handle streaming
                this.handleStreamingCall(client, methodName, request, callMetadata, options, resolve, reject);
            } else {
                // Unary call
                method.call(client, request, callMetadata, options, (error, response) => {
                    if (error) {
                        this.stats.errors++;
                        this.logger.error(`gRPC call error: ${error.message}`);
                        
                        // Retry logic
                        if (service.retries > 0 && this.isRetryableError(error)) {
                            this.logger.info(`Retrying gRPC call: ${methodName}`);
                            service.retries--;
                            return this.proxyCall(serviceName, methodName, request, metadata)
                                .then(resolve)
                                .catch(reject);
                        }
                        
                        reject(error);
                    } else {
                        this.stats.responses++;
                        resolve(response);
                    }
                });
            }
        });
    }

    // Handle streaming gRPC calls
    handleStreamingCall(client, methodName, request, metadata, options, resolve, reject) {
        const method = client[methodName];
        const isRequestStream = method.requestStream;
        const isResponseStream = method.responseStream;
        
        if (isRequestStream && isResponseStream) {
            // Bidirectional streaming
            const call = method.call(client, metadata, options);
            resolve(call); // Return the stream for the caller to handle
            
        } else if (isRequestStream) {
            // Client streaming
            const call = method.call(client, metadata, options, (error, response) => {
                if (error) {
                    this.stats.errors++;
                    reject(error);
                } else {
                    this.stats.responses++;
                    resolve(response);
                }
            });
            
            // Write the request data if it's an array
            if (Array.isArray(request)) {
                request.forEach(item => call.write(item));
                call.end();
            } else {
                resolve(call); // Return stream for caller to write to
            }
            
        } else if (isResponseStream) {
            // Server streaming
            const call = method.call(client, request, metadata, options);
            const responses = [];
            
            call.on('data', (response) => {
                responses.push(response);
            });
            
            call.on('error', (error) => {
                this.stats.errors++;
                reject(error);
            });
            
            call.on('end', () => {
                this.stats.responses++;
                resolve(responses);
            });
        }
    }

    // Check if error is retryable
    isRetryableError(error) {
        const retryableCodes = [
            grpc.status.UNAVAILABLE,
            grpc.status.DEADLINE_EXCEEDED,
            grpc.status.RESOURCE_EXHAUSTED,
            grpc.status.ABORTED
        ];
        
        return retryableCodes.includes(error.code);
    }

    // HTTP/2 proxy for gRPC-Web
    createHttp2Proxy() {
        const server = http2.createSecureServer({
            key: fs.readFileSync(process.env.SSL_KEY_PATH || './certs/key.pem'),
            cert: fs.readFileSync(process.env.SSL_CERT_PATH || './certs/cert.pem')
        });
        
        server.on('stream', async (stream, headers) => {
            const path = headers[':path'];
            const method = headers[':method'];
            
            // Extract service and method from path
            const pathMatch = path.match(/^\/([^/]+)\/([^/]+)/);
            if (!pathMatch) {
                stream.respond({ ':status': 404 });
                stream.end('Not Found');
                return;
            }
            
            const [, serviceName, methodName] = pathMatch;
            const service = this.services.get(serviceName);
            
            if (!service) {
                stream.respond({ ':status': 404 });
                stream.end('Service Not Found');
                return;
            }
            
            // Proxy to backend
            try {
                await proxy(stream, headers, {
                    hostname: new URL(service.backend).hostname,
                    port: new URL(service.backend).port || 443,
                    path: path,
                    protocol: 'https:',
                    onReq: (req) => {
                        // Add custom headers
                        for (const [key, value] of Object.entries(service.metadata)) {
                            req.setHeader(key, value);
                        }
                    }
                });
                
                this.stats.requests++;
                this.stats.activeStreams++;
                
                stream.on('close', () => {
                    this.stats.activeStreams--;
                });
                
            } catch (error) {
                this.logger.error(`HTTP/2 proxy error: ${error.message}`);
                this.stats.errors++;
                
                stream.respond({ ':status': 502 });
                stream.end('Bad Gateway');
            }
        });
        
        return server;
    }

    // gRPC-Web compatibility layer
    grpcWebMiddleware() {
        return async (req, res, next) => {
            // Check if this is a gRPC-Web request
            const contentType = req.headers['content-type'];
            if (!contentType || !contentType.includes('application/grpc')) {
                return next();
            }
            
            // Extract service and method
            const pathMatch = req.path.match(/^\/([^/]+)\/([^/]+)/);
            if (!pathMatch) {
                return res.status(404).json({ error: 'Invalid gRPC path' });
            }
            
            const [, serviceName, methodName] = pathMatch;
            
            try {
                // Parse gRPC-Web request
                const requestData = await this.parseGrpcWebRequest(req);
                
                // Proxy the call
                const response = await this.proxyCall(
                    serviceName,
                    methodName,
                    requestData,
                    this.extractMetadata(req.headers)
                );
                
                // Format response for gRPC-Web
                const grpcWebResponse = this.formatGrpcWebResponse(response);
                
                res.set({
                    'Content-Type': 'application/grpc-web+proto',
                    'grpc-status': '0',
                    'grpc-message': 'OK'
                });
                
                res.send(grpcWebResponse);
                
            } catch (error) {
                this.logger.error(`gRPC-Web error: ${error.message}`);
                
                res.set({
                    'Content-Type': 'application/grpc-web+proto',
                    'grpc-status': error.code || '2',
                    'grpc-message': error.message
                });
                
                res.status(500).end();
            }
        };
    }

    // Parse gRPC-Web request
    async parseGrpcWebRequest(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    
                    // Skip the 5-byte header (compressed flag + message length)
                    const message = buffer.slice(5);
                    
                    // TODO: Properly deserialize based on proto definition
                    // For now, return raw buffer
                    resolve(message);
                } catch (error) {
                    reject(error);
                }
            });
            req.on('error', reject);
        });
    }

    // Format response for gRPC-Web
    formatGrpcWebResponse(response) {
        // TODO: Properly serialize based on proto definition
        const message = Buffer.isBuffer(response) ? response : Buffer.from(JSON.stringify(response));
        
        // Create 5-byte header (uncompressed flag + message length)
        const header = Buffer.allocUnsafe(5);
        header.writeUInt8(0, 0); // Uncompressed
        header.writeUInt32BE(message.length, 1);
        
        return Buffer.concat([header, message]);
    }

    // Extract metadata from headers
    extractMetadata(headers) {
        const metadata = {};
        
        for (const [key, value] of Object.entries(headers)) {
            if (key.startsWith('grpc-') || key.startsWith('x-')) {
                metadata[key] = value;
            }
        }
        
        return metadata;
    }

    // Health check for gRPC services
    async checkHealth(serviceName) {
        const service = this.services.get(serviceName);
        if (!service || !service.healthCheck) {
            return { status: 'UNKNOWN' };
        }
        
        try {
            const client = this.getClient(serviceName);
            
            // Standard gRPC health check
            const health = new grpc.health.v1.Health(
                service.backend.replace(/^https?:\/\//, ''),
                grpc.credentials.createInsecure()
            );
            
            return new Promise((resolve) => {
                health.check({ service: service.serviceName }, (error, response) => {
                    if (error) {
                        resolve({ status: 'NOT_SERVING', error: error.message });
                    } else {
                        resolve({ status: response.status });
                    }
                });
            });
        } catch (error) {
            return { status: 'NOT_SERVING', error: error.message };
        }
    }

    // Get statistics
    getStats() {
        const methodStats = Array.from(this.stats.byMethod.entries())
            .map(([method, count]) => ({ method, count }))
            .sort((a, b) => b.count - a.count);
        
        return {
            totalRequests: this.stats.requests,
            totalResponses: this.stats.responses,
            totalErrors: this.stats.errors,
            errorRate: this.stats.requests > 0 
                ? ((this.stats.errors / this.stats.requests) * 100).toFixed(2) + '%'
                : '0%',
            activeStreams: this.stats.activeStreams,
            registeredServices: this.services.size,
            activeClients: this.clients.size,
            topMethods: methodStats.slice(0, 10)
        };
    }

    // Clean up resources
    async shutdown() {
        this.logger.info('Shutting down gRPC proxy');
        
        // Close all client connections
        for (const [key, client] of this.clients) {
            client.close();
        }
        
        this.clients.clear();
        this.services.clear();
    }
}

module.exports = GrpcProxy;