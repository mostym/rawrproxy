const axios = require('axios');
const WebSocketTester = require('./WebSocketTester');

class BackendHealthChecker {
    constructor(database, logger) {
        this.db = database;
        this.logger = logger;
        this.wsTester = new WebSocketTester(logger);
        this.checkInterval = 30000; // 30 seconds
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        this.logger.info('Starting backend health checker');
        
        // Do initial check
        await this.checkAllBackends();
        
        // Schedule periodic checks
        this.intervalId = setInterval(() => {
            this.checkAllBackends();
        }, this.checkInterval);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        this.logger.info('Stopped backend health checker');
    }

    async checkAllBackends() {
        try {
            const backends = await this.db.getBackends();
            
            for (const backend of backends) {
                await this.checkBackend(backend);
            }
        } catch (error) {
            this.logger.error(`Health check error: ${error.message}`);
        }
    }

    async checkBackend(backend) {
        const startTime = Date.now();
        let healthy = false;
        let wsEndpoint = null;
        let wsSupported = false;
        
        try {
            // HTTP health check
            const response = await axios.get(backend.url + (backend.health_check_path || '/'), {
                timeout: 5000,
                validateStatus: (status) => status < 500
            });
            
            healthy = response.status < 400;
            
            // WebSocket test
            const wsTest = await this.wsTester.findBestEndpoint(backend.url);
            if (wsTest) {
                wsSupported = true;
                wsEndpoint = wsTest.endpoint;
                this.logger.info(`Backend ${backend.name} supports WebSocket at ${wsTest.endpoint}`);
            }
            
        } catch (error) {
            this.logger.error(`Health check failed for ${backend.name}: ${error.message}`);
            healthy = false;
        }
        
        const responseTime = Date.now() - startTime;
        
        // Update backend in database
        await this.db.run(`
            UPDATE backends 
            SET healthy = ?,
                last_check = ?,
                response_time = ?,
                ws_endpoint = ?,
                ws_supported = ?
            WHERE id = ?
        `, [
            healthy ? 1 : 0,
            new Date().toISOString(),
            responseTime,
            wsEndpoint,
            wsSupported ? 1 : 0,
            backend.id
        ]);
        
        // Log status change
        if (backend.healthy !== healthy) {
            this.logger.info(`Backend ${backend.name} status changed: ${healthy ? 'UP' : 'DOWN'}`);
        }
        
        return {
            backend: backend.name,
            healthy,
            responseTime,
            wsSupported,
            wsEndpoint
        };
    }

    async testWebSocketForBackend(backendId) {
        const backend = await this.db.get('SELECT * FROM backends WHERE id = ?', [backendId]);
        if (!backend) {
            throw new Error('Backend not found');
        }
        
        const results = await this.wsTester.testBackend(backend.url);
        
        // Update backend with WebSocket info
        if (results.workingEndpoints.length > 0) {
            const best = await this.wsTester.findBestEndpoint(backend.url);
            await this.db.run(`
                UPDATE backends 
                SET ws_endpoint = ?,
                    ws_supported = 1
                WHERE id = ?
            `, [best.endpoint, backendId]);
        }
        
        return results;
    }
}

module.exports = BackendHealthChecker;