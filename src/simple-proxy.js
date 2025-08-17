const httpProxy = require('http-proxy');
const http = require('http');
const Database = require('./database/Database');

async function startSimpleProxy() {
    const db = new Database();
    await db.initialize();
    
    // Create a simple proxy
    const proxy = httpProxy.createProxyServer({
        ws: true,
        changeOrigin: true,
        secure: false
    });
    
    // Handle errors
    proxy.on('error', (err, req, res) => {
        console.error('Proxy error:', err.message);
        if (res.writeHead) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Bad Gateway');
        }
    });
    
    // Create the server
    const server = http.createServer(async (req, res) => {
        const host = req.headers.host;
        console.log(`HTTP request: ${host}${req.url}`);
        
        // Get routing from database
        const routing = await db.getDomainRouting(host);
        
        if (routing && routing.backends.length > 0) {
            const target = routing.backends[0].url;
            console.log(`Routing ${host} -> ${target}`);
            proxy.web(req, res, { target });
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('No backend configured for ' + host);
        }
    });
    
    // Handle WebSocket upgrades
    server.on('upgrade', async (req, socket, head) => {
        const host = req.headers.host;
        console.log(`WebSocket upgrade: ${host}${req.url}`);
        
        // Get routing from database
        const routing = await db.getDomainRouting(host);
        
        if (routing && routing.backends.length > 0) {
            const target = routing.backends[0].url;
            console.log(`WebSocket routing ${host} -> ${target}`);
            proxy.ws(req, socket, head, { target });
        } else {
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        }
    });
    
    // Start the server
    server.listen(80, '0.0.0.0', () => {
        console.log('Simple proxy server listening on port 80');
        console.log('WebSocket support enabled');
    });
}

startSimpleProxy().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});