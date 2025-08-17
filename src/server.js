require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const ProxyManager = require('./proxy/ProxyManager');
const AuthManager = require('./auth/AuthManager');
const AdminPanel = require('./admin/AdminPanel');
const Logger = require('./utils/Logger');
const Database = require('./database/Database');
const ProxmoxIntegration = require('./integrations/ProxmoxIntegration');
const CloudflareIntegration = require('./integrations/CloudflareIntegration');

class RAWRProxyServer {
    constructor() {
        this.app = express();
        this.adminApp = express();
        this.logger = new Logger();
        this.db = new Database();
        this.authManager = new AuthManager(this.db);
        this.proxyManager = new ProxyManager(this.logger, this.authManager, this.db);
        this.proxmoxIntegration = new ProxmoxIntegration(this.db, this.logger);
        this.cloudflareIntegration = new CloudflareIntegration(this.db, this.logger);
        this.adminPanel = new AdminPanel(this.adminApp, this.db, this.logger, this.proxmoxIntegration, this.cloudflareIntegration, this.proxyManager);
        
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        const helmet = require('helmet');
        const cors = require('cors');
        const compression = require('compression');
        const morgan = require('morgan');
        const rateLimit = require('express-rate-limit');
        const bodyParser = require('body-parser');
        const cookieParser = require('cookie-parser');
        const session = require('express-session');

        // Use helmet but disable CSP for reverse proxy
        // Let backend applications handle their own CSP
        this.app.use(helmet({
            contentSecurityPolicy: false
        }));
        this.app.use(cors());
        this.app.use(compression());
        
        // Apply body parser only to non-proxy routes
        // Proxy routes need raw body to forward properly
        this.app.use((req, res, next) => {
            // Skip body parsing for proxy routes
            if (req.path.startsWith('/proxy/') || req.path === '/proxy' || 
                (req.path !== '/health' && req.path !== '/auth/login' && 
                 req.path !== '/auth/register' && req.path !== '/auth/refresh')) {
                return next();
            }
            bodyParser.json({ limit: '50mb' })(req, res, next);
        });
        
        this.app.use((req, res, next) => {
            // Skip body parsing for proxy routes
            if (req.path.startsWith('/proxy/') || req.path === '/proxy' || 
                (req.path !== '/health' && req.path !== '/auth/login' && 
                 req.path !== '/auth/register' && req.path !== '/auth/refresh')) {
                return next();
            }
            bodyParser.urlencoded({ extended: true, limit: '50mb' })(req, res, next);
        });
        
        this.app.use(cookieParser());

        this.app.use(session({
            secret: process.env.JWT_SECRET || 'default-secret',
            resave: false,
            saveUninitialized: false,
            cookie: { secure: process.env.HTTPS_ENABLED === 'true' }
        }));

        if (process.env.LOG_LEVEL !== 'none') {
            this.app.use(morgan('combined', { stream: this.logger.stream }));
        }

        if (process.env.RATE_LIMIT_ENABLED === 'true') {
            const limiter = rateLimit({
                windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
                max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
                message: 'Too many requests from this IP'
            });
            this.app.use('/proxy', limiter);
        }
    }

    setupRoutes() {
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy',
                uptime: process.uptime(),
                mode: {
                    forward: process.env.ENABLE_FORWARD_PROXY === 'true',
                    reverse: process.env.ENABLE_REVERSE_PROXY === 'true'
                }
            });
        });

        if (process.env.AUTH_ENABLED === 'true') {
            this.app.post('/auth/login', this.authManager.login.bind(this.authManager));
            this.app.post('/auth/register', this.authManager.register.bind(this.authManager));
            this.app.post('/auth/refresh', this.authManager.refresh.bind(this.authManager));
            this.app.use('/proxy', this.authManager.authenticate.bind(this.authManager));
        }

        if (process.env.ENABLE_FORWARD_PROXY === 'true') {
            this.app.use('/proxy/forward', this.proxyManager.handleForwardProxy.bind(this.proxyManager));
        }

        if (process.env.ENABLE_REVERSE_PROXY === 'true') {
            this.app.use('/proxy/reverse', this.proxyManager.handleReverseProxy.bind(this.proxyManager));
        }

        // Mount domain-specific proxy middleware
        this.app.use(async (req, res, next) => {
            const host = req.get('host');
            
            // Check if this is a WebSocket upgrade request
            const isWebSocketUpgrade = req.headers.upgrade === 'websocket' && 
                                      req.headers.connection && 
                                      req.headers.connection.toLowerCase().includes('upgrade');
            
            // Log WebSocket upgrade attempts
            if (req.url && req.url.includes('socket.io')) {
                this.logger.info(`Socket.IO request: ${req.method} ${req.url} from ${host}, Upgrade: ${req.headers.upgrade}, isWebSocketUpgrade: ${isWebSocketUpgrade}`);
            }
            
            if (!host) {
                return this.proxyManager.handleAutoProxy(req, res, next);
            }
            
            // Get routing for this host
            const routing = await this.db.getDomainRouting(host);
            
            
            if (!routing || routing.backends.length === 0) {
                return this.proxyManager.handleAutoProxy(req, res, next);
            }
            
            // Get backend for this request
            const poolKey = routing.subdomain ? 
                `${routing.subdomain.subdomain}.${routing.domain.domain}` : 
                routing.domain.domain;
            
            let pool = this.proxyManager.backendPools.get(poolKey);
            
            
            if (!pool && routing.backends.length > 0) {
                const BackendPool = require('./proxy/BackendPool');
                pool = new BackendPool(
                    routing.backends,
                    routing.backends[0]?.load_balance_method || 'round_robin',
                    this.logger
                );
                this.proxyManager.backendPools.set(poolKey, pool);
            }
            
            if (pool) {
                const backend = pool.getNextBackend(req.ip);
                if (backend) {
                    const target = backend.url;
                    
                    // Special handling for WebSocket upgrades from Cloudflare
                    if (isWebSocketUpgrade) {
                        this.logger.info(`Handling WebSocket upgrade through middleware for ${host} -> ${target}`);
                        
                        // Use the existing WebSocket proxy from setupWebSocketHandler
                        if (this.wsProxy) {
                            // Set proper headers for the WebSocket connection
                            req.headers['sec-websocket-version'] = req.headers['sec-websocket-version'] || '13';
                            req.headers['sec-websocket-key'] = req.headers['sec-websocket-key'] || 'dGhlIHNhbXBsZSBub25jZQ==';
                            
                            // Proxy the WebSocket connection
                            this.wsProxy.ws(req, req.socket, Buffer.alloc(0), {
                                target: target,
                                changeOrigin: true,
                                ws: true,
                                secure: false
                            });
                        } else {
                            console.error('WebSocket proxy not initialized');
                            if (!res.headersSent) {
                                res.status(500).send('WebSocket proxy not initialized');
                            }
                        }
                        
                        return; // Don't continue with regular HTTP processing
                    }
                    
                    // Get or create proxy middleware instance for regular HTTP
                    // Pass hostname to ensure each domain gets its own proxy instance
                    const proxy = this.proxyManager.getOrCreateProxyInstance(target, backend, host);
                    // Use the proxy middleware
                    return proxy(req, res, next);
                }
            }
            
            // Fallback to auto proxy
            return this.proxyManager.handleAutoProxy(req, res, next);
        });
    }

    async start() {
        // Increase max listeners to prevent memory leak warnings
        require('events').EventEmitter.defaultMaxListeners = 100;
        
        await this.db.initialize();
        
        // Initialize backend pools after database is ready
        await this.proxyManager.initializeBackendPools();
        
        // Start backend health checker with WebSocket detection
        // Disabled temporarily - blocking startup
        // const BackendHealthChecker = require('./utils/BackendHealthChecker');
        // this.healthChecker = new BackendHealthChecker(this.db, this.logger);
        // await this.healthChecker.checkAllBackends();
        // this.healthChecker.start();
        
        // Initialize Proxmox integration if configured
        const proxmoxConfig = await this.db.get('SELECT * FROM proxmox_config WHERE enabled = 1');
        if (proxmoxConfig) {
            await this.proxmoxIntegration.initialize(proxmoxConfig);
        }
        
        // Initialize Cloudflare integration if configured
        const cloudflareConfig = await this.db.get('SELECT * FROM cloudflare_config WHERE enabled = 1');
        if (cloudflareConfig) {
            // Map database columns to expected config format
            const config = {
                email: cloudflareConfig.email,
                apiKey: cloudflareConfig.api_key,
                apiToken: cloudflareConfig.api_token,
                accountId: cloudflareConfig.account_id,
                tunnelEnabled: cloudflareConfig.tunnel_enabled === 1,
                tunnelId: cloudflareConfig.tunnel_id,
                autoSSL: cloudflareConfig.auto_ssl === 1,
                autoDNS: cloudflareConfig.auto_dns === 1,
                proxied: cloudflareConfig.proxied === 1
            };
            await this.cloudflareIntegration.initialize(config);
        }
        
        const httpPort = process.env.PORT || 80;
        const httpsPort = process.env.HTTPS_PORT || 443;
        const adminPort = process.env.ADMIN_PORT || 8081;

        // Always create HTTP server for port 80
        this.httpServer = http.createServer(this.app);
        
        // Set up WebSocket handling BEFORE setting up the middleware
        this.setupWebSocketHandler();
        
        // Admin panel always uses HTTP for easier access
        this.adminServer = http.createServer(this.adminApp);
        
        if (process.env.HTTPS_ENABLED === 'true') {
            const options = await this.getSSLOptions();
            
            // Create HTTPS server for port 443
            this.httpsServer = https.createServer(options, this.app);
            
            // Setup WebSocket on HTTPS server
            if (process.env.WEBSOCKET_ENABLED === 'true') {
                this.setupWebSocket(this.httpsServer);
            }
            
            // Start HTTPS server on port 443
            this.httpsServer.listen(httpsPort, '0.0.0.0', () => {
                this.logger.info(`HTTPS Proxy server listening on 0.0.0.0:${httpsPort}`);
            });
        } else {
            // Setup WebSocket on HTTP server
            if (process.env.WEBSOCKET_ENABLED === 'true') {
                this.setupWebSocket(this.httpServer);
            }
        }

        // Always start HTTP server on port 80
        this.httpServer.listen(httpPort, '0.0.0.0', () => {
            this.logger.info(`HTTP Proxy server listening on 0.0.0.0:${httpPort}`);
            this.logger.info(`WebSocket enabled: ${process.env.WEBSOCKET_ENABLED === 'true'}`);
        });

        this.adminServer.listen(adminPort, '0.0.0.0', () => {
            this.logger.info(`Admin panel listening on 0.0.0.0:${adminPort}`);
        });
    }

    async getSSLOptions() {
        const selfsigned = require('selfsigned');
        
        let cert, key;
        
        if (fs.existsSync(process.env.SSL_CERT_PATH) && fs.existsSync(process.env.SSL_KEY_PATH)) {
            cert = fs.readFileSync(process.env.SSL_CERT_PATH);
            key = fs.readFileSync(process.env.SSL_KEY_PATH);
        } else {
            this.logger.warn('SSL certificates not found, generating self-signed certificates');
            const attrs = [{ name: 'commonName', value: 'localhost' }];
            const pems = selfsigned.generate(attrs, { days: 365 });
            
            const certsDir = path.dirname(process.env.SSL_CERT_PATH || './certs/cert.pem');
            if (!fs.existsSync(certsDir)) {
                fs.mkdirSync(certsDir, { recursive: true });
            }
            
            fs.writeFileSync(process.env.SSL_CERT_PATH || './certs/cert.pem', pems.cert);
            fs.writeFileSync(process.env.SSL_KEY_PATH || './certs/key.pem', pems.private);
            
            cert = pems.cert;
            key = pems.private;
        }
        
        return { cert, key };
    }

    setupWebSocketHandler() {
        const httpProxy = require('http-proxy');
        const BackendPool = require('./proxy/BackendPool');
        
        // Create a dedicated WebSocket proxy
        this.wsProxy = httpProxy.createProxyServer({
            ws: true,
            changeOrigin: true,
            secure: false,
            autoRewrite: false,  // Don't rewrite location headers
            followRedirects: false,  // Don't follow redirects
            xfwd: true,  // Add X-Forwarded headers
            preserveHeaderKeyCase: true  // Preserve header case
        });
        
        this.wsProxy.on('error', (err, req, socket) => {
            this.logger.error(`WebSocket proxy error: ${err.message}`);
            if (socket && !socket.destroyed) {
                socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            }
        });
        
        // Forward cookies and authentication headers
        this.wsProxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
            // Log original headers for debugging
            this.logger.info(`WebSocket headers: ${JSON.stringify({
                cookie: req.headers.cookie ? 'present' : 'missing',
                authorization: req.headers.authorization ? 'present' : 'missing',
                'x-immich-user-token': req.headers['x-immich-user-token'] ? 'present' : 'missing',
                'x-api-key': req.headers['x-api-key'] ? 'present' : 'missing'
            })}`);
            
            // Forward authentication headers
            if (req.headers.cookie) {
                proxyReq.setHeader('Cookie', req.headers.cookie);
            }
            if (req.headers.authorization) {
                proxyReq.setHeader('Authorization', req.headers.authorization);
            }
            if (req.headers['x-immich-user-token']) {
                proxyReq.setHeader('x-immich-user-token', req.headers['x-immich-user-token']);
            }
            if (req.headers['x-api-key']) {
                proxyReq.setHeader('x-api-key', req.headers['x-api-key']);
            }
            if (req.headers['x-csrf-token']) {
                proxyReq.setHeader('x-csrf-token', req.headers['x-csrf-token']);
            }
        });
        
        // Handle WebSocket upgrades
        this.httpServer.on('upgrade', async (request, socket, head) => {
            const host = request.headers.host;
            const originalUrl = request.url;
            this.logger.info(`WebSocket upgrade request for ${host}${originalUrl}`);
            
            try {
                // Get routing for this host
                const routing = await this.db.getDomainRouting(host);
                
                if (routing && routing.backends.length > 0) {
                    // Get backend using pool for load balancing
                    const poolKey = routing.subdomain ? 
                        `${routing.subdomain.subdomain}.${routing.domain.domain}` : 
                        routing.domain.domain;
                    
                    let pool = this.proxyManager.backendPools.get(poolKey);
                    if (!pool) {
                        pool = new BackendPool(
                            routing.backends,
                            routing.backends[0]?.load_balance_method || 'round_robin',
                            this.logger
                        );
                        this.proxyManager.backendPools.set(poolKey, pool);
                    }
                    
                    const backend = pool.getNextBackend(request.connection.remoteAddress);
                    if (!backend) {
                        throw new Error('No healthy backend available');
                    }
                    
                    // Check if backend has a known WebSocket endpoint
                    let targetUrl = backend.url;
                    
                    // Only redirect to known endpoint for specific services like Socket.IO
                    // Frigate has multiple WebSocket endpoints (/ws, /live/jsmpeg/*, etc)
                    if (backend.ws_endpoint && backend.ws_supported && originalUrl.includes('socket.io')) {
                        // If the request is not already to the WebSocket endpoint, redirect to it
                        if (!originalUrl.includes(backend.ws_endpoint)) {
                            request.url = backend.ws_endpoint;
                            this.logger.info(`Redirecting Socket.IO WebSocket to known endpoint: ${backend.ws_endpoint}`);
                        }
                    }
                    
                    this.logger.info(`WebSocket routing ${host} -> ${targetUrl}${request.url}`);
                    
                    // Proxy the WebSocket connection with cookie and header preservation
                    this.wsProxy.ws(request, socket, head, { 
                        target: targetUrl,
                        changeOrigin: true,
                        ws: true,
                        // Forward cookies and headers
                        cookieDomainRewrite: false,
                        cookiePathRewrite: false,
                        preserveHeaderKeyCase: true
                    });
                } else {
                    this.logger.error(`No backend found for WebSocket ${host}`);
                    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
                }
            } catch (error) {
                this.logger.error(`WebSocket routing error: ${error.message}`);
                if (socket && !socket.destroyed) {
                    socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                }
            }
        });
        
        this.logger.info('WebSocket handler configured with endpoint detection');
    }
    
    setupWebSocket(server) {
        // This method is called later but WebSocket is already set up
        this.logger.info('WebSocket support enabled for proxy');
    }
}

const server = new RAWRProxyServer();
server.start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});