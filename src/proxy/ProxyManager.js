const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');
const url = require('url');
const CacheManager = require('../cache/CacheManager');
const RequestModifier = require('./RequestModifier');
const ResponseModifier = require('./ResponseModifier');
const BackendPool = require('./BackendPool');
const WebSocketManager = require('../websocket/WebSocketManager');

class ProxyManager {
    constructor(logger, authManager, database) {
        this.logger = logger;
        this.authManager = authManager;
        this.db = database;
        this.cacheManager = new CacheManager(logger);
        this.requestModifier = new RequestModifier();
        this.responseModifier = new ResponseModifier();
        this.blockedDomains = (process.env.BLOCKED_DOMAINS || '').split(',').filter(d => d);
        this.reverseProxyTargets = (process.env.REVERSE_PROXY_TARGETS || '').split(',').filter(t => t);
        this.currentTargetIndex = 0;
        this.backendPools = new Map();
        this.wsManager = new WebSocketManager(logger);
        this.proxyInstances = new Map(); // Cache proxy middleware instances
        // Don't initialize pools in constructor - wait for database to be ready
    }

    getOrCreateProxyInstance(target, backend = null, hostname = null) {
        // Include hostname in cache key to prevent proxy instance sharing between domains
        const cacheKey = hostname ? `${hostname}:${target}` : target;
        
        if (this.proxyInstances.has(cacheKey)) {
            this.logger.debug(`Returning cached proxy instance for ${cacheKey}`);
            return this.proxyInstances.get(cacheKey);
        }
        
        this.logger.info(`Creating NEW proxy instance for ${cacheKey} (hostname: ${hostname}, target: ${target})`)
        
        const proxyOptions = {
            target,
            changeOrigin: true,
            ws: false, // DISABLE WebSocket support in middleware - we handle it separately
            xfwd: true,
            secure: false,
            preserveHeaderKeyCase: true,
            followRedirects: false,
            timeout: 120000,
            proxyTimeout: 120000,
            // Remove onProxyReqWs handler - WebSocket is handled separately in server.js
            onProxyReq: (proxyReq, req, res) => {
                if (proxyReq.headersSent) {
                    return;
                }
                
                try {
                    const originalHost = req.headers.host || req.get('host');
                    
                    if (originalHost) {
                        proxyReq.setHeader('X-Forwarded-Host', originalHost);
                    }
                    
                    proxyReq.setHeader('X-Forwarded-For', req.ip || req.connection.remoteAddress);
                    proxyReq.setHeader('X-Forwarded-Proto', 'https');
                    proxyReq.setHeader('X-Real-IP', req.ip || req.connection.remoteAddress);
                    
                    if (req.headers['x-emby-authorization']) {
                        proxyReq.setHeader('X-Emby-Authorization', req.headers['x-emby-authorization']);
                    }
                    
                    this.logger.debug(`Proxying to ${target} with X-Forwarded-Host: ${originalHost}`);
                } catch (err) {
                    if (err.code !== 'ERR_HTTP_HEADERS_SENT') {
                        this.logger.error(`Error setting proxy headers: ${err.message}`);
                    }
                }
            },
            onProxyRes: async (proxyRes, req, res) => {
                const host = req.headers.host || req.get('host');
                
                // Don't add Clear-Site-Data for WebSocket or Socket.IO requests
                const isSocketIO = req.url && req.url.includes('socket.io');
                
                // For pix and frigate domains, add header to clear site data if switching between them
                if (!isSocketIO && host && (host.includes('pix.rawrinc.com') || host.includes('frigate.rawrinc.com'))) {
                    // Check if the referrer is from a different subdomain
                    const referrer = req.headers.referer || req.headers.referrer || '';
                    const isDifferentSubdomain = (
                        (host.includes('pix.rawrinc.com') && referrer.includes('frigate.rawrinc.com')) ||
                        (host.includes('frigate.rawrinc.com') && referrer.includes('pix.rawrinc.com'))
                    );
                    
                    // Only clear site data when actually switching between subdomains
                    if (isDifferentSubdomain) {
                        // This header tells the browser to clear cache only, not storage
                        proxyRes.headers['clear-site-data'] = '"cache"';
                    }
                }
                
                if (proxyRes.statusCode === 302 && proxyRes.headers.location) {
                    const location = proxyRes.headers.location;
                    if (location === 'web/index.html' || location === '/web/index.html') {
                        proxyRes.headers.location = '/web/index.html';
                    }
                }
                
                // Add cache control headers to prevent cross-domain caching issues
                // (host already declared above)
                
                // Add backend identifier header for debugging
                if (backend && backend.name) {
                    proxyRes.headers['x-proxy-backend'] = backend.name;
                }
                
                // Force service worker isolation per subdomain
                if (host) {
                    // Set Vary header to ensure caches consider the Host header
                    proxyRes.headers['vary'] = 'Host, Origin, Cookie';
                    
                    // Add Service-Worker-Allowed header to restrict service worker scope
                    proxyRes.headers['service-worker-allowed'] = '/';
                    
                    // For service worker files, add specific cache headers
                    if (req.path === '/service-worker.js' || req.path === '/sw.js') {
                        proxyRes.headers['cache-control'] = 'max-age=0, must-revalidate';
                        // Add a unique identifier to force different service workers per domain
                        proxyRes.headers['x-sw-domain'] = host;
                    }
                    
                    // For HTML pages, prevent caching to avoid service worker conflicts
                    if (req.path === '/' || req.path === '/photos' || req.path === '/index.html' || !req.path.includes('.')) {
                        proxyRes.headers['cache-control'] = 'no-cache, no-store, must-revalidate, private';
                        proxyRes.headers['pragma'] = 'no-cache';
                        proxyRes.headers['expires'] = '0';
                        // Clear any ETags to prevent 304 responses
                        delete proxyRes.headers['etag'];
                        delete proxyRes.headers['last-modified'];
                    }
                }
                
                await this.handleProxyResponse(proxyRes, req, res, target);
                
                if (backend) {
                    const pool = Array.from(this.backendPools.values()).find(p => 
                        p.backends.includes(backend)
                    );
                    if (pool) pool.markBackendSuccess(backend);
                }
            },
            onError: (err, req, res) => {
                this.logger.error(`Reverse proxy error: ${err.message}`);
                
                if (backend) {
                    const pool = Array.from(this.backendPools.values()).find(p => 
                        p.backends.includes(backend)
                    );
                    if (pool) pool.markBackendFailed(backend);
                }
                
                // Check if this is a WebSocket error (res might be a socket)
                if (res && res.status && !res.headersSent) {
                    res.status(502).json({ error: 'Bad Gateway', message: err.message });
                } else if (res && res.end) {
                    // For WebSocket errors, just end the socket
                    res.end();
                }
            },
            logLevel: 'silent'
        };
        
        const proxy = createProxyMiddleware(proxyOptions);
        this.proxyInstances.set(cacheKey, proxy);
        return proxy;
    }

    async initializeBackendPools() {
        try {
            const domains = await this.db.getDomains();
            for (const domain of domains) {
                // Get only backends for the ROOT domain (not subdomains)
                const query = `
                    SELECT DISTINCT b.* 
                    FROM backends b
                    JOIN domain_backends db ON b.id = db.backendId
                    WHERE db.domainId = ? AND db.subdomainId IS NULL AND b.active = 1
                `;
                const backends = await this.db.all(query, [domain.id]);
                
                this.logger.info(`Domain ${domain.domain}: Found ${backends.length} backends`);
                if (backends.length > 0) {
                    const pool = new BackendPool(
                        backends,
                        backends[0]?.load_balance_method || 'round_robin',
                        this.logger
                    );
                    this.backendPools.set(domain.domain, pool);
                    this.logger.info(`Created pool for ${domain.domain} with ${backends.length} backends`);
                }
            }
            
            // Start health checking
            setInterval(() => {
                this.performHealthChecks();
            }, 30000);
            
            this.logger.info(`Initialized ${this.backendPools.size} backend pools`);
        } catch (error) {
            this.logger.error(`Failed to initialize backend pools: ${error.message}`);
        }
    }

    async performHealthChecks() {
        for (const [domain, pool] of this.backendPools) {
            await pool.checkAllBackendsHealth();
        }
    }

    async handleForwardProxy(req, res) {
        try {
            const targetUrl = req.query.url || req.body.url;
            
            if (!targetUrl) {
                return res.status(400).json({ error: 'Target URL is required' });
            }

            const parsedUrl = url.parse(targetUrl);
            
            if (this.isBlocked(parsedUrl.hostname)) {
                this.logger.warn(`Blocked request to ${parsedUrl.hostname}`);
                return res.status(403).json({ error: 'Domain is blocked' });
            }

            this.logger.info(`Forward proxy request to ${targetUrl}`);

            if (process.env.CACHE_ENABLED === 'true' && req.method === 'GET') {
                const cachedResponse = await this.cacheManager.get(targetUrl);
                if (cachedResponse) {
                    this.logger.info(`Serving cached response for ${targetUrl}`);
                    return res.json(cachedResponse);
                }
            }

            const modifiedRequest = await this.requestModifier.modify(req, {
                targetUrl,
                type: 'forward'
            });

            const proxyOptions = {
                target: targetUrl,
                changeOrigin: true,
                ws: true, // Always enable WebSocket support
                onProxyReq: (proxyReq, req, res) => {
                    this.handleProxyRequest(proxyReq, req, modifiedRequest);
                },
                onProxyRes: async (proxyRes, req, res) => {
                    await this.handleProxyResponse(proxyRes, req, res, targetUrl);
                },
                onError: (err, req, res) => {
                    this.logger.error(`Proxy error: ${err.message}`);
                    res.status(500).json({ error: 'Proxy error', message: err.message });
                },
                logLevel: 'silent'
            };

            const proxy = createProxyMiddleware(proxyOptions);
            proxy(req, res);
        } catch (error) {
            this.logger.error(`Forward proxy error: ${error.message}`);
            res.status(500).json({ error: 'Internal proxy error' });
        }
    }

    async handleReverseProxy(req, res, next) {
        try {
            // Check for domain-based routing first
            const host = req.get('host');
            let target = null;
            let backend = null;
            
            if (host) {
                this.logger.info(`Reverse proxy request from ${host}`);
                const routing = await this.db.getDomainRouting(host);
                if (routing && routing.backends.length > 0) {
                    this.logger.info(`Found ${routing.backends.length} backends for ${host}`);
                    
                    // Create a temporary pool for subdomain-specific backends
                    const poolKey = routing.subdomain ? `${routing.subdomain.subdomain}.${routing.domain.domain}` : routing.domain.domain;
                    let pool = this.backendPools.get(poolKey);
                    
                    if (!pool || routing.subdomain) {
                        // For subdomains, create a specific pool with only their backends
                        pool = new BackendPool(
                            routing.backends,
                            routing.backends[0]?.load_balance_method || 'round_robin',
                            this.logger
                        );
                        if (routing.subdomain) {
                            this.backendPools.set(poolKey, pool);
                        }
                    }
                    
                    if (pool) {
                        this.logger.info(`Pool for ${poolKey} has ${pool.backends.length} backends`);
                        backend = pool.getNextBackend(req.ip);
                        if (backend) {
                            target = backend.url;
                            this.logger.info(`Routing ${host} to backend ${target}`);
                            
                            // Apply subdomain path prefix if configured
                            if (routing.subdomain && routing.subdomain.path_prefix) {
                                req.url = routing.subdomain.path_prefix + req.url;
                            }
                        }
                    }
                }
            }
            
            // Fallback to simple round-robin if no domain routing
            if (!target) {
                target = this.getNextTarget();
            }
            
            if (!target) {
                return res.status(503).json({ error: 'No backend servers available' });
            }

            this.logger.info(`Reverse proxy request from ${host} to ${target}`);

            const modifiedRequest = await this.requestModifier.modify(req, {
                targetUrl: target,
                type: 'reverse'
            });

            // Use cached proxy instance for better WebSocket support
            const proxy = this.getOrCreateProxyInstance(target, backend);
            return proxy(req, res, next || (() => {}));
        } catch (error) {
            this.logger.error(`Reverse proxy error: ${error.message}`);
            res.status(500).json({ error: 'Internal proxy error' });
        }
    }

    async handleAutoProxy(req, res, next) {
        const path = req.path;
        const host = req.get('host');
        
        // Check for domain-based routing first
        if (host) {
            const routing = await this.db.getDomainRouting(host);
            if (routing && routing.backends.length > 0) {
                // We have a valid domain with backends, use reverse proxy
                return this.handleReverseProxy(req, res, next);
            }
        }
        
        if (path.startsWith('/api/') || path.startsWith('/backend/')) {
            return this.handleReverseProxy(req, res);
        } else if (req.headers['x-proxy-target']) {
            req.query.url = req.headers['x-proxy-target'];
            return this.handleForwardProxy(req, res);
        } else if (this.reverseProxyTargets.length > 0) {
            return this.handleReverseProxy(req, res);
        } else {
            res.status(404).json({ 
                error: 'No proxy route matched',
                hint: 'Use /proxy/forward?url=TARGET or /proxy/reverse'
            });
        }
    }

    handleProxyRequest(proxyReq, req, modifiedRequest) {
        // This is now handled in onProxyReq directly
        // Keeping for backward compatibility
    }

    async handleProxyResponse(proxyRes, req, res, targetUrl) {
        // Check if headers have already been sent
        if (res.headersSent) {
            return;
        }
        
        const modifiedResponse = await this.responseModifier.modify(proxyRes, {
            targetUrl,
            method: req.method
        });

        if (modifiedResponse.headers && !res.headersSent) {
            Object.keys(modifiedResponse.headers).forEach(key => {
                try {
                    res.setHeader(key, modifiedResponse.headers[key]);
                } catch (err) {
                    // Header already sent, ignore
                    this.logger.debug(`Could not set header ${key}: ${err.message}`);
                }
            });
        }

        if (process.env.CACHE_ENABLED === 'true' && req.method === 'GET' && proxyRes.statusCode === 200) {
            let body = '';
            proxyRes.on('data', chunk => {
                body += chunk;
            });
            proxyRes.on('end', async () => {
                await this.cacheManager.set(targetUrl, {
                    status: proxyRes.statusCode,
                    headers: proxyRes.headers,
                    body
                });
            });
        }

        this.logger.info(`Proxy response: ${proxyRes.statusCode} from ${targetUrl}`);
    }

    async handleWebSocketMessage(ws, message) {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'proxy-request') {
                const response = await this.processWebSocketProxy(data);
                ws.send(JSON.stringify(response));
            }
        } catch (error) {
            ws.send(JSON.stringify({ 
                error: 'Invalid message format',
                details: error.message 
            }));
        }
    }

    async processWebSocketProxy(data) {
        try {
            const response = await axios({
                method: data.method || 'GET',
                url: data.url,
                headers: data.headers || {},
                data: data.body
            });

            return {
                type: 'proxy-response',
                status: response.status,
                headers: response.headers,
                data: response.data
            };
        } catch (error) {
            return {
                type: 'proxy-error',
                error: error.message,
                status: error.response?.status
            };
        }
    }

    isBlocked(hostname) {
        return this.blockedDomains.some(domain => {
            return hostname === domain || hostname.endsWith(`.${domain}`);
        });
    }

    getNextTarget() {
        if (this.reverseProxyTargets.length === 0) return null;
        
        const target = this.reverseProxyTargets[this.currentTargetIndex];
        this.currentTargetIndex = (this.currentTargetIndex + 1) % this.reverseProxyTargets.length;
        
        return target;
    }

    markTargetUnhealthy(target) {
        this.logger.warn(`Marking target ${target} as unhealthy`);
    }
}

module.exports = ProxyManager;