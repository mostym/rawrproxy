const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const url = require('url');

class WebSocketTester {
    constructor(logger) {
        this.logger = logger;
        this.commonEndpoints = [
            '/socket.io/?EIO=4&transport=websocket',
            '/socket.io/?EIO=3&transport=websocket', 
            '/ws',
            '/websocket',
            '/live/webrtc/ws',
            '/api/ws',
            '/api/websocket',
            '/hub',
            '/signalr',
            '/sockjs-node',
            '/',
            '/mqtt',
            '/stomp',
            '/events',
            '/stream',
            '/realtime',
            '/notifications/ws',
            '/chat',
            '/cable',
            '/graphql-ws'
        ];
    }

    /**
     * Test if a backend supports WebSocket at various common endpoints
     */
    async testBackend(backendUrl) {
        const results = {
            url: backendUrl,
            supportsWebSocket: false,
            workingEndpoints: [],
            testedEndpoints: [],
            errors: []
        };

        // Parse the backend URL
        const parsed = url.parse(backendUrl);
        const baseUrl = `${parsed.protocol}//${parsed.host}`;

        // Test each common endpoint
        for (const endpoint of this.commonEndpoints) {
            const wsUrl = baseUrl.replace(/^http/, 'ws') + endpoint;
            const testResult = await this.testEndpoint(wsUrl);
            
            results.testedEndpoints.push({
                endpoint,
                url: wsUrl,
                success: testResult.success,
                error: testResult.error
            });

            if (testResult.success) {
                results.supportsWebSocket = true;
                results.workingEndpoints.push({
                    endpoint,
                    url: wsUrl,
                    protocol: testResult.protocol
                });
                this.logger.info(`Found working WebSocket endpoint: ${wsUrl}`);
            }
        }

        // Also test with HTTP upgrade request
        const upgradeTest = await this.testHttpUpgrade(backendUrl);
        if (upgradeTest.success) {
            results.supportsWebSocket = true;
            results.httpUpgradeSupport = true;
        }

        return results;
    }

    /**
     * Test a specific WebSocket endpoint
     */
    async testEndpoint(wsUrl, timeout = 3000) {
        return new Promise((resolve) => {
            let ws;
            const timer = setTimeout(() => {
                if (ws) ws.terminate();
                resolve({ success: false, error: 'Connection timeout' });
            }, timeout);

            try {
                ws = new WebSocket(wsUrl, {
                    rejectUnauthorized: false,
                    handshakeTimeout: timeout,
                    headers: {
                        'User-Agent': 'RAWRProxy-WebSocket-Tester/1.0'
                    }
                });

                ws.on('open', () => {
                    clearTimeout(timer);
                    const protocol = ws.protocol || 'websocket';
                    ws.close();
                    resolve({ success: true, protocol });
                });

                ws.on('error', (err) => {
                    clearTimeout(timer);
                    resolve({ success: false, error: err.message });
                });

                ws.on('unexpected-response', (req, res) => {
                    clearTimeout(timer);
                    resolve({ 
                        success: false, 
                        error: `HTTP ${res.statusCode} ${res.statusMessage}` 
                    });
                });
            } catch (err) {
                clearTimeout(timer);
                resolve({ success: false, error: err.message });
            }
        });
    }

    /**
     * Test HTTP upgrade capability
     */
    async testHttpUpgrade(backendUrl) {
        return new Promise((resolve) => {
            const parsed = url.parse(backendUrl);
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: '/',
                method: 'GET',
                headers: {
                    'Connection': 'Upgrade',
                    'Upgrade': 'websocket',
                    'Sec-WebSocket-Version': '13',
                    'Sec-WebSocket-Key': Buffer.from('test').toString('base64')
                }
            };

            const protocol = parsed.protocol === 'https:' ? https : http;
            
            const req = protocol.request(options, (res) => {
                if (res.statusCode === 101) {
                    resolve({ success: true, statusCode: 101 });
                } else {
                    resolve({ 
                        success: false, 
                        statusCode: res.statusCode,
                        error: `HTTP ${res.statusCode}` 
                    });
                }
            });

            req.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });

            req.on('upgrade', (res, socket, head) => {
                socket.end();
                resolve({ success: true, statusCode: 101 });
            });

            req.setTimeout(3000, () => {
                req.destroy();
                resolve({ success: false, error: 'Timeout' });
            });

            req.end();
        });
    }

    /**
     * Find the best WebSocket endpoint for a backend
     */
    async findBestEndpoint(backendUrl) {
        const results = await this.testBackend(backendUrl);
        
        if (results.workingEndpoints.length > 0) {
            // Prefer Socket.IO endpoints
            const socketIo = results.workingEndpoints.find(e => 
                e.endpoint.includes('socket.io'));
            if (socketIo) return socketIo;
            
            // Then prefer /ws or /websocket
            const ws = results.workingEndpoints.find(e => 
                e.endpoint === '/ws' || e.endpoint === '/websocket');
            if (ws) return ws;
            
            // Return first working endpoint
            return results.workingEndpoints[0];
        }
        
        return null;
    }
}

module.exports = WebSocketTester;