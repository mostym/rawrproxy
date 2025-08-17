const EventEmitter = require('events');
const Logger = require('./Logger');

class CircuitBreaker extends EventEmitter {
    constructor(options = {}) {
        super();
        this.logger = new Logger();
        
        // Configuration
        this.name = options.name || 'default';
        this.timeout = options.timeout || 10000; // Request timeout in ms
        this.errorThreshold = options.errorThreshold || 50; // Error percentage to trip
        this.volumeThreshold = options.volumeThreshold || 10; // Minimum requests before tripping
        this.resetTimeout = options.resetTimeout || 30000; // Time before trying half-open
        this.halfOpenRequests = options.halfOpenRequests || 3; // Requests to test in half-open state
        
        // State management
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failures = 0;
        this.successes = 0;
        this.requests = 0;
        this.lastFailureTime = null;
        this.nextAttempt = null;
        this.halfOpenAttempts = 0;
        
        // Metrics window (rolling window for error rate calculation)
        this.windowSize = options.windowSize || 10000; // 10 seconds
        this.requestWindow = [];
        
        // Fallback function
        this.fallback = options.fallback || null;
        
        this.logger.info(`Circuit breaker '${this.name}' initialized`);
    }

    async execute(fn, ...args) {
        // Check if circuit is open
        if (this.state === 'OPEN') {
            if (Date.now() >= this.nextAttempt) {
                this.transitionToHalfOpen();
            } else {
                return await this.handleOpen();
            }
        }

        // Check if we're in half-open state
        if (this.state === 'HALF_OPEN' && this.halfOpenAttempts >= this.halfOpenRequests) {
            return await this.handleOpen();
        }

        // Try to execute the function
        try {
            const result = await this.executeWithTimeout(fn, args);
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure(error);
            throw error;
        }
    }

    async executeWithTimeout(fn, args) {
        return new Promise(async (resolve, reject) => {
            let timeoutId;
            
            // Set timeout
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`Circuit breaker timeout after ${this.timeout}ms`));
                }, this.timeout);
            });

            try {
                // Race between function execution and timeout
                const result = await Promise.race([
                    fn(...args),
                    timeoutPromise
                ]);
                
                clearTimeout(timeoutId);
                resolve(result);
            } catch (error) {
                clearTimeout(timeoutId);
                reject(error);
            }
        });
    }

    onSuccess() {
        this.requests++;
        this.successes++;
        
        // Add to request window
        this.addToWindow(true);
        
        // Handle state transitions on success
        if (this.state === 'HALF_OPEN') {
            this.halfOpenAttempts++;
            
            // Check if we have enough successful requests to close the circuit
            const recentRequests = this.getRecentRequests();
            const successRate = this.calculateSuccessRate(recentRequests);
            
            if (this.halfOpenAttempts >= this.halfOpenRequests && successRate >= (100 - this.errorThreshold)) {
                this.transitionToClosed();
            }
        } else if (this.state === 'OPEN') {
            // Shouldn't happen, but handle it
            this.transitionToHalfOpen();
        }
        
        this.emit('success', {
            circuit: this.name,
            state: this.state,
            stats: this.getStats()
        });
    }

    onFailure(error) {
        this.requests++;
        this.failures++;
        this.lastFailureTime = Date.now();
        
        // Add to request window
        this.addToWindow(false);
        
        // Check if we should trip the circuit
        if (this.state === 'CLOSED') {
            const recentRequests = this.getRecentRequests();
            
            if (recentRequests.length >= this.volumeThreshold) {
                const errorRate = this.calculateErrorRate(recentRequests);
                
                if (errorRate >= this.errorThreshold) {
                    this.transitionToOpen();
                }
            }
        } else if (this.state === 'HALF_OPEN') {
            // Any failure in half-open state reopens the circuit
            this.transitionToOpen();
        }
        
        this.emit('failure', {
            circuit: this.name,
            state: this.state,
            error: error.message,
            stats: this.getStats()
        });
    }

    async handleOpen() {
        this.emit('open', {
            circuit: this.name,
            nextAttempt: this.nextAttempt
        });
        
        if (this.fallback) {
            try {
                return await this.fallback();
            } catch (fallbackError) {
                throw new Error(`Circuit breaker is OPEN and fallback failed: ${fallbackError.message}`);
            }
        }
        
        throw new Error(`Circuit breaker '${this.name}' is OPEN`);
    }

    transitionToOpen() {
        this.state = 'OPEN';
        this.nextAttempt = Date.now() + this.resetTimeout;
        this.halfOpenAttempts = 0;
        
        this.logger.warn(`Circuit breaker '${this.name}' transitioned to OPEN`);
        this.emit('stateChange', {
            circuit: this.name,
            from: this.state,
            to: 'OPEN',
            nextAttempt: this.nextAttempt
        });
    }

    transitionToHalfOpen() {
        const previousState = this.state;
        this.state = 'HALF_OPEN';
        this.halfOpenAttempts = 0;
        
        this.logger.info(`Circuit breaker '${this.name}' transitioned to HALF_OPEN`);
        this.emit('stateChange', {
            circuit: this.name,
            from: previousState,
            to: 'HALF_OPEN'
        });
    }

    transitionToClosed() {
        const previousState = this.state;
        this.state = 'CLOSED';
        this.failures = 0;
        this.halfOpenAttempts = 0;
        this.nextAttempt = null;
        
        this.logger.info(`Circuit breaker '${this.name}' transitioned to CLOSED`);
        this.emit('stateChange', {
            circuit: this.name,
            from: previousState,
            to: 'CLOSED'
        });
    }

    addToWindow(success) {
        const now = Date.now();
        this.requestWindow.push({
            timestamp: now,
            success: success
        });
        
        // Remove old entries outside the window
        const cutoff = now - this.windowSize;
        this.requestWindow = this.requestWindow.filter(req => req.timestamp > cutoff);
    }

    getRecentRequests() {
        const now = Date.now();
        const cutoff = now - this.windowSize;
        return this.requestWindow.filter(req => req.timestamp > cutoff);
    }

    calculateErrorRate(requests) {
        if (requests.length === 0) return 0;
        const failures = requests.filter(req => !req.success).length;
        return (failures / requests.length) * 100;
    }

    calculateSuccessRate(requests) {
        if (requests.length === 0) return 100;
        const successes = requests.filter(req => req.success).length;
        return (successes / requests.length) * 100;
    }

    // Force open the circuit (useful for manual intervention)
    forceOpen() {
        this.transitionToOpen();
    }

    // Force close the circuit (useful for manual intervention)
    forceClose() {
        this.transitionToClosed();
    }

    // Reset all statistics
    reset() {
        this.state = 'CLOSED';
        this.failures = 0;
        this.successes = 0;
        this.requests = 0;
        this.lastFailureTime = null;
        this.nextAttempt = null;
        this.halfOpenAttempts = 0;
        this.requestWindow = [];
        
        this.logger.info(`Circuit breaker '${this.name}' reset`);
        this.emit('reset', { circuit: this.name });
    }

    getStats() {
        const recentRequests = this.getRecentRequests();
        const errorRate = this.calculateErrorRate(recentRequests);
        const successRate = this.calculateSuccessRate(recentRequests);
        
        return {
            name: this.name,
            state: this.state,
            requests: this.requests,
            failures: this.failures,
            successes: this.successes,
            errorRate: errorRate.toFixed(2) + '%',
            successRate: successRate.toFixed(2) + '%',
            lastFailureTime: this.lastFailureTime,
            nextAttempt: this.nextAttempt,
            recentRequestCount: recentRequests.length
        };
    }

    // Check if circuit is currently allowing requests
    isAllowingRequests() {
        if (this.state === 'CLOSED') return true;
        if (this.state === 'OPEN' && Date.now() >= this.nextAttempt) return true;
        if (this.state === 'HALF_OPEN' && this.halfOpenAttempts < this.halfOpenRequests) return true;
        return false;
    }
}

// Circuit breaker manager for managing multiple circuits
class CircuitBreakerManager {
    constructor() {
        this.breakers = new Map();
        this.logger = new Logger();
    }

    create(name, options = {}) {
        if (this.breakers.has(name)) {
            return this.breakers.get(name);
        }
        
        const breaker = new CircuitBreaker({ ...options, name });
        this.breakers.set(name, breaker);
        
        // Listen to state changes for logging
        breaker.on('stateChange', (data) => {
            this.logger.info(`Circuit breaker state change: ${JSON.stringify(data)}`);
        });
        
        return breaker;
    }

    get(name) {
        return this.breakers.get(name);
    }

    getAll() {
        return Array.from(this.breakers.values());
    }

    getStats() {
        const stats = {};
        for (const [name, breaker] of this.breakers) {
            stats[name] = breaker.getStats();
        }
        return stats;
    }

    reset(name) {
        const breaker = this.breakers.get(name);
        if (breaker) {
            breaker.reset();
        }
    }

    resetAll() {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
    }
}

module.exports = { CircuitBreaker, CircuitBreakerManager };