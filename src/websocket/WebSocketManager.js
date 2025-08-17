const WebSocket = require('ws');
const { EventEmitter } = require('events');

class WebSocketManager extends EventEmitter {
    constructor(logger) {
        super();
        this.logger = logger;
        this.pools = new Map(); // target -> WebSocket connections
        this.connections = new Map(); // clientId -> { client, target, backend }
        this.metrics = {
            totalConnections: 0,
            activeConnections: 0,
            messagesProxied: 0,
            bytesTransferred: 0,
            errors: 0,
            connectionsByBackend: new Map()
        };
        this.healthChecks = new Map(); // target -> last health check
        this.socketIOSupport = true;
        
        // Start health monitoring
        this.startHealthMonitoring();
    }

    /**
     * Handle incoming WebSocket upgrade request
     */
    async handleUpgrade(req, socket, head, backend) {
        const clientId = this.generateClientId();
        const target = backend.url;
        
        this.logger.info(`WebSocket upgrade request from ${req.headers.host} to ${target}`);
        
        try {
            // Check if this is a Socket.IO connection
            const isSocketIO = this.isSocketIORequest(req);
            
            // Get or create backend WebSocket connection
            const backendWs = await this.getOrCreateBackendConnection(target, req, isSocketIO);
            
            // Create client WebSocket
            const wss = new WebSocket.Server({ noServer: true });
            wss.handleUpgrade(req, socket, head, (clientWs) => {
                this.setupClientConnection(clientId, clientWs, backendWs, target, backend);
            });
            
            // Update metrics
            this.metrics.totalConnections++;
            this.metrics.activeConnections++;
            this.updateBackendMetrics(backend.name, 1);
            
        } catch (error) {
            this.logger.error(`WebSocket upgrade failed: ${error.message}`);
            socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            this.metrics.errors++;
        }
    }

    /**
     * Setup bidirectional proxy between client and backend
     */
    setupClientConnection(clientId, clientWs, backendWs, target, backend) {
        // Store connection info
        this.connections.set(clientId, {
            client: clientWs,
            backend: backendWs,
            target,
            backendInfo: backend,
            startTime: Date.now(),
            messagesFromClient: 0,
            messagesFromBackend: 0,
            bytesFromClient: 0,
            bytesFromBackend: 0
        });

        // Client -> Backend
        clientWs.on('message', (data) => {
            try {
                if (backendWs.readyState === WebSocket.OPEN) {
                    backendWs.send(data);
                    
                    // Update metrics
                    const conn = this.connections.get(clientId);
                    if (conn) {
                        conn.messagesFromClient++;
                        conn.bytesFromClient += data.length;
                        this.metrics.messagesProxied++;
                        this.metrics.bytesTransferred += data.length;
                    }
                    
                    // Log Socket.IO events if applicable
                    if (this.isSocketIOMessage(data)) {
                        this.logSocketIOEvent(data, 'client->backend');
                    }
                }
            } catch (error) {
                this.logger.error(`Error proxying client message: ${error.message}`);
                this.metrics.errors++;
            }
        });

        // Backend -> Client
        backendWs.on('message', (data) => {
            try {
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(data);
                    
                    // Update metrics
                    const conn = this.connections.get(clientId);
                    if (conn) {
                        conn.messagesFromBackend++;
                        conn.bytesFromBackend += data.length;
                        this.metrics.messagesProxied++;
                        this.metrics.bytesTransferred += data.length;
                    }
                    
                    // Log Socket.IO events if applicable
                    if (this.isSocketIOMessage(data)) {
                        this.logSocketIOEvent(data, 'backend->client');
                    }
                }
            } catch (error) {
                this.logger.error(`Error proxying backend message: ${error.message}`);
                this.metrics.errors++;
            }
        });

        // Handle client disconnect
        clientWs.on('close', () => {
            this.handleClientDisconnect(clientId);
        });

        clientWs.on('error', (error) => {
            this.logger.error(`Client WebSocket error: ${error.message}`);
            this.metrics.errors++;
            this.handleClientDisconnect(clientId);
        });

        // Handle backend disconnect
        backendWs.on('close', () => {
            this.logger.info(`Backend WebSocket closed for ${target}`);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close();
            }
            this.removeFromPool(target, backendWs);
        });

        backendWs.on('error', (error) => {
            this.logger.error(`Backend WebSocket error for ${target}: ${error.message}`);
            this.metrics.errors++;
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close();
            }
            this.removeFromPool(target, backendWs);
        });

        // Send connection established event
        this.emit('connection', {
            clientId,
            target,
            backend: backend.name,
            timestamp: Date.now()
        });

        this.logger.info(`WebSocket connection established: ${clientId} -> ${target}`);
    }

    /**
     * Get or create a backend WebSocket connection from the pool
     */
    async getOrCreateBackendConnection(target, req, isSocketIO) {
        // For now, create a new connection for each client
        // TODO: Implement connection pooling for backends that support it
        
        const wsUrl = target.replace(/^http/, 'ws');
        const backendUrl = isSocketIO ? `${wsUrl}/socket.io/?${req.url.split('?')[1] || ''}` : wsUrl + req.url;
        
        return new Promise((resolve, reject) => {
            const backendWs = new WebSocket(backendUrl, {
                headers: {
                    ...req.headers,
                    host: new URL(target).host
                }
            });

            backendWs.on('open', () => {
                this.addToPool(target, backendWs);
                resolve(backendWs);
            });

            backendWs.on('error', (error) => {
                reject(error);
            });

            // Set timeout for connection
            setTimeout(() => {
                if (backendWs.readyState !== WebSocket.OPEN) {
                    backendWs.terminate();
                    reject(new Error('Backend WebSocket connection timeout'));
                }
            }, 10000);
        });
    }

    /**
     * Check if request is for Socket.IO
     */
    isSocketIORequest(req) {
        return req.url && (
            req.url.includes('/socket.io/') ||
            req.url.includes('transport=websocket') ||
            req.headers['sec-websocket-protocol'] === 'socket.io'
        );
    }

    /**
     * Check if message is Socket.IO formatted
     */
    isSocketIOMessage(data) {
        if (!this.socketIOSupport) return false;
        
        try {
            const str = data.toString();
            // Socket.IO messages typically start with a number (packet type)
            return /^[0-9]/.test(str);
        } catch {
            return false;
        }
    }

    /**
     * Log Socket.IO events for debugging
     */
    logSocketIOEvent(data, direction) {
        try {
            const str = data.toString();
            const match = str.match(/^(\d)(.*)$/);
            if (match) {
                const packetType = match[1];
                const content = match[2];
                
                const types = {
                    '0': 'CONNECT',
                    '1': 'DISCONNECT',
                    '2': 'EVENT',
                    '3': 'ACK',
                    '4': 'ERROR',
                    '5': 'BINARY_EVENT',
                    '6': 'BINARY_ACK'
                };
                
                this.logger.debug(`Socket.IO ${direction}: ${types[packetType] || 'UNKNOWN'} - ${content.substring(0, 100)}`);
            }
        } catch (error) {
            // Ignore parse errors
        }
    }

    /**
     * Handle client disconnect
     */
    handleClientDisconnect(clientId) {
        const conn = this.connections.get(clientId);
        if (conn) {
            // Log connection statistics
            const duration = Date.now() - conn.startTime;
            this.logger.info(`WebSocket disconnected: ${clientId} after ${duration}ms`, {
                messagesFromClient: conn.messagesFromClient,
                messagesFromBackend: conn.messagesFromBackend,
                bytesFromClient: conn.bytesFromClient,
                bytesFromBackend: conn.bytesFromBackend
            });

            // Update metrics
            this.metrics.activeConnections--;
            this.updateBackendMetrics(conn.backendInfo.name, -1);

            // Close backend connection if not reusable
            if (conn.backend && conn.backend.readyState === WebSocket.OPEN) {
                conn.backend.close();
            }

            // Remove from tracking
            this.connections.delete(clientId);

            // Emit disconnect event
            this.emit('disconnect', {
                clientId,
                target: conn.target,
                backend: conn.backendInfo.name,
                duration,
                stats: {
                    messagesFromClient: conn.messagesFromClient,
                    messagesFromBackend: conn.messagesFromBackend,
                    bytesFromClient: conn.bytesFromClient,
                    bytesFromBackend: conn.bytesFromBackend
                }
            });
        }
    }

    /**
     * Add connection to pool
     */
    addToPool(target, ws) {
        if (!this.pools.has(target)) {
            this.pools.set(target, new Set());
        }
        this.pools.get(target).add(ws);
    }

    /**
     * Remove connection from pool
     */
    removeFromPool(target, ws) {
        const pool = this.pools.get(target);
        if (pool) {
            pool.delete(ws);
            if (pool.size === 0) {
                this.pools.delete(target);
            }
        }
    }

    /**
     * Update per-backend metrics
     */
    updateBackendMetrics(backendName, delta) {
        const current = this.metrics.connectionsByBackend.get(backendName) || 0;
        this.metrics.connectionsByBackend.set(backendName, Math.max(0, current + delta));
    }

    /**
     * Start health monitoring for WebSocket connections
     */
    startHealthMonitoring() {
        setInterval(() => {
            // Check all active connections
            for (const [clientId, conn] of this.connections) {
                // Ping client if it exists
                if (conn.client && conn.client.readyState === WebSocket.OPEN) {
                    conn.client.ping();
                }
                
                // Ping backend if it exists
                if (conn.backend && conn.backend.readyState === WebSocket.OPEN) {
                    conn.backend.ping();
                }
            }

            // Clean up dead connections
            for (const [target, pool] of this.pools) {
                for (const ws of pool) {
                    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
                        pool.delete(ws);
                    }
                }
                if (pool.size === 0) {
                    this.pools.delete(target);
                }
            }

            // Log metrics
            this.logger.debug('WebSocket health check', {
                activeConnections: this.metrics.activeConnections,
                pools: this.pools.size,
                backends: Array.from(this.metrics.connectionsByBackend.entries())
            });
        }, 30000); // Every 30 seconds
    }

    /**
     * Generate unique client ID
     */
    generateClientId() {
        return `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get current metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            connectionsByBackend: Array.from(this.metrics.connectionsByBackend.entries()).map(([backend, count]) => ({
                backend,
                count
            })),
            pools: Array.from(this.pools.entries()).map(([target, pool]) => ({
                target,
                connections: pool.size
            })),
            activeConnectionDetails: Array.from(this.connections.entries()).map(([clientId, conn]) => ({
                clientId,
                target: conn.target,
                backend: conn.backend || (conn.backendInfo ? conn.backendInfo.name : 'unknown'),
                duration: Date.now() - conn.startTime,
                messagesFromClient: conn.messagesFromClient || 0,
                messagesFromBackend: conn.messagesFromBackend || 0,
                bytesFromClient: conn.bytesFromClient || 0,
                bytesFromBackend: conn.bytesFromBackend || 0
            }))
        };
    }

    /**
     * Close all connections gracefully
     */
    async shutdown() {
        this.logger.info('Shutting down WebSocket manager...');
        
        // Close all client connections
        for (const [clientId, conn] of this.connections) {
            if (conn.client.readyState === WebSocket.OPEN) {
                conn.client.close();
            }
            if (conn.backend.readyState === WebSocket.OPEN) {
                conn.backend.close();
            }
        }

        // Clear pools
        for (const [target, pool] of this.pools) {
            for (const ws of pool) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            }
        }

        this.pools.clear();
        this.connections.clear();
    }
}

module.exports = WebSocketManager;