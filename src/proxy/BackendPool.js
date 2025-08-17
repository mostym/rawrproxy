const axios = require('axios');

class BackendPool {
    constructor(backends, method = 'round_robin', logger) {
        this.backends = backends;
        this.method = method;
        this.logger = logger;
        this.currentIndex = 0;
        this.stickySessionMap = new Map();
        this.failureCount = new Map();
        this.lastHealthCheck = new Map();
    }

    getNextBackend(sessionId = null) {
        if (this.backends.length === 0) {
            return null;
        }

        const healthyBackends = this.backends.filter(b => b.healthy !== false);
        if (healthyBackends.length === 0) {
            this.logger.warn('No healthy backends available');
            return null;
        }

        let backend;

        switch (this.method) {
            case 'round_robin':
                backend = this.roundRobin(healthyBackends);
                break;
            case 'least_connections':
                backend = this.leastConnections(healthyBackends);
                break;
            case 'weighted':
                backend = this.weighted(healthyBackends);
                break;
            case 'ip_hash':
                backend = this.ipHash(healthyBackends, sessionId);
                break;
            case 'sticky':
                backend = this.sticky(healthyBackends, sessionId);
                break;
            default:
                backend = this.roundRobin(healthyBackends);
        }

        return backend;
    }

    roundRobin(backends) {
        const backend = backends[this.currentIndex % backends.length];
        this.currentIndex++;
        return backend;
    }

    weighted(backends) {
        const totalWeight = backends.reduce((sum, b) => sum + (b.weight || 1), 0);
        let random = Math.random() * totalWeight;
        
        for (const backend of backends) {
            random -= (backend.weight || 1);
            if (random <= 0) {
                return backend;
            }
        }
        
        return backends[0];
    }

    leastConnections(backends) {
        return backends.reduce((least, current) => {
            const leastConns = least.activeConnections || 0;
            const currentConns = current.activeConnections || 0;
            return currentConns < leastConns ? current : least;
        });
    }

    ipHash(backends, identifier) {
        if (!identifier) {
            return this.roundRobin(backends);
        }
        
        const hash = this.hashString(identifier);
        const index = hash % backends.length;
        return backends[index];
    }

    sticky(backends, sessionId) {
        if (!sessionId) {
            return this.roundRobin(backends);
        }

        if (this.stickySessionMap.has(sessionId)) {
            const backend = this.stickySessionMap.get(sessionId);
            if (backend.healthy !== false) {
                return backend;
            }
        }

        const backend = this.roundRobin(backends);
        this.stickySessionMap.set(sessionId, backend);
        
        // Clean up old sessions periodically
        if (this.stickySessionMap.size > 10000) {
            const entriesToDelete = Array.from(this.stickySessionMap.keys()).slice(0, 1000);
            entriesToDelete.forEach(key => this.stickySessionMap.delete(key));
        }
        
        return backend;
    }

    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }

    markBackendFailed(backend) {
        const failures = (this.failureCount.get(backend.id) || 0) + 1;
        this.failureCount.set(backend.id, failures);
        
        if (failures >= (backend.max_fails || 3)) {
            backend.healthy = false;
            this.logger.warn(`Backend ${backend.url} marked as unhealthy after ${failures} failures`);
            
            // Schedule recovery check
            setTimeout(() => {
                this.checkBackendHealth(backend);
            }, (backend.fail_timeout || 30) * 1000);
        }
    }

    markBackendSuccess(backend) {
        this.failureCount.set(backend.id, 0);
        if (backend.healthy === false) {
            backend.healthy = true;
            this.logger.info(`Backend ${backend.url} recovered and marked as healthy`);
        }
    }

    async checkBackendHealth(backend) {
        const lastCheck = this.lastHealthCheck.get(backend.id) || 0;
        const now = Date.now();
        
        // Prevent too frequent health checks
        if (now - lastCheck < 5000) {
            return backend.healthy !== false;
        }
        
        this.lastHealthCheck.set(backend.id, now);
        
        try {
            const startTime = Date.now();
            const response = await axios.get(
                backend.url + (backend.health_check_path || '/health'),
                {
                    timeout: 5000,
                    validateStatus: (status) => status < 500
                }
            );
            
            const responseTime = Date.now() - startTime;
            
            if (response.status < 400) {
                backend.healthy = true;
                backend.response_time = responseTime;
                this.failureCount.set(backend.id, 0);
                return true;
            } else {
                this.markBackendFailed(backend);
                return false;
            }
        } catch (error) {
            this.logger.debug(`Health check failed for ${backend.url}: ${error.message}`);
            this.markBackendFailed(backend);
            return false;
        }
    }

    async checkAllBackendsHealth() {
        const checks = this.backends.map(backend => this.checkBackendHealth(backend));
        await Promise.all(checks);
        
        const healthy = this.backends.filter(b => b.healthy !== false).length;
        const total = this.backends.length;
        
        this.logger.info(`Health check complete: ${healthy}/${total} backends healthy`);
        
        return {
            healthy,
            total,
            backends: this.backends.map(b => ({
                url: b.url,
                healthy: b.healthy !== false,
                responseTime: b.response_time
            }))
        };
    }

    getStatistics() {
        return {
            total: this.backends.length,
            healthy: this.backends.filter(b => b.healthy !== false).length,
            method: this.method,
            backends: this.backends.map(b => ({
                id: b.id,
                url: b.url,
                weight: b.weight || 1,
                healthy: b.healthy !== false,
                failures: this.failureCount.get(b.id) || 0,
                responseTime: b.response_time,
                activeConnections: b.activeConnections || 0
            }))
        };
    }

    addBackend(backend) {
        this.backends.push(backend);
        this.logger.info(`Added backend ${backend.url} to pool`);
    }

    removeBackend(backendId) {
        const index = this.backends.findIndex(b => b.id === backendId);
        if (index !== -1) {
            const removed = this.backends.splice(index, 1)[0];
            this.failureCount.delete(backendId);
            this.lastHealthCheck.delete(backendId);
            this.logger.info(`Removed backend ${removed.url} from pool`);
            return true;
        }
        return false;
    }

    updateBackend(backendId, updates) {
        const backend = this.backends.find(b => b.id === backendId);
        if (backend) {
            Object.assign(backend, updates);
            this.logger.info(`Updated backend ${backend.url}`);
            return true;
        }
        return false;
    }
}

module.exports = BackendPool;