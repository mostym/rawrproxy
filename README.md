# RAWRProxy

A powerful, enterprise-grade reverse proxy server with advanced routing, load balancing, and WebSocket support. Built with Node.js and designed for high-performance multi-domain hosting environments.

## Features

### Core Capabilities
- **Multi-Domain Routing**: Route requests to different backends based on domain/subdomain
- **WebSocket Support**: Full WebSocket proxy support with Socket.IO compatibility
- **Load Balancing**: Multiple load balancing methods (round-robin, least-connections, IP-hash)
- **SSL/TLS Support**: HTTPS with automatic certificate generation
- **Database-Driven Configuration**: SQLite-based configuration management
- **Health Monitoring**: Automatic backend health checks and failover
- **Caching**: Built-in caching layer for improved performance
- **Admin Panel**: Web-based administration interface

### Advanced Features
- **Cloudflare Integration**: Automatic DNS and tunnel management
- **Proxmox Integration**: VM/Container discovery and management
- **Authentication**: JWT-based authentication system
- **Request/Response Modification**: Flexible middleware for header manipulation
- **WebSocket Metrics**: Real-time connection tracking and statistics
- **Domain-Based Backend Pools**: Isolated backend pools per domain
- **Service Worker Isolation**: Prevents cross-domain cache conflicts

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Client Requests                       │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                   RAWRProxy Server                       │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │   Domain     │  │  WebSocket   │  │    Admin     │ │
│  │   Router     │  │   Handler    │  │    Panel     │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │   Backend    │  │   Health     │  │   Cache      │ │
│  │    Pools     │  │   Checker    │  │   Manager    │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    Backend Servers                       │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │  Immich  │  │ Frigate  │  │ Proxmox  │  │  Apps  │ │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites
- Node.js 18+ 
- PM2 (for process management)
- SQLite3

### Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/rawrproxy.git
cd rawrproxy
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Initialize the database:
```bash
npm run db:init
```

5. Start the server:
```bash
# Development
npm run dev

# Production with PM2
npm run start:prod
```

## Configuration

### Environment Variables

Key environment variables in `.env`:

```env
# Server Configuration
PORT=80
HTTPS_PORT=443
ADMIN_PORT=8081
HTTPS_ENABLED=true

# Database
DATABASE_PATH=./data/proxy.db

# WebSocket
WEBSOCKET_ENABLED=true

# Logging
LOG_LEVEL=info
LOG_FILE_PATH=./logs/proxy.log

# Authentication
AUTH_ENABLED=false
JWT_SECRET=your-secret-key

# SSL Certificates
SSL_CERT_PATH=./certs/cert.pem
SSL_KEY_PATH=./certs/key.pem
```

### Database Schema

The proxy uses SQLite with the following main tables:
- `domains`: Root domain configurations
- `subdomains`: Subdomain configurations
- `backends`: Backend server definitions
- `domain_backends`: Domain-to-backend mappings
- `cloudflare_config`: Cloudflare integration settings
- `proxmox_config`: Proxmox integration settings

## Usage

### Adding a Domain

```javascript
// Via Admin Panel: http://localhost:8081
// Or via database:
INSERT INTO domains (domain, active) VALUES ('example.com', 1);
INSERT INTO backends (name, url, active) VALUES ('app-server', 'http://192.168.1.100:3000', 1);
INSERT INTO domain_backends (domainId, backendId) VALUES (1, 1);
```

### WebSocket Configuration

For services like Immich that use Socket.IO:

```sql
UPDATE backends 
SET ws_supported = 1, 
    ws_endpoint = '/api/socket.io/?EIO=4&transport=websocket'
WHERE name = 'immich-backend';
```

## API Endpoints

### Health Check
```
GET /health
```

### Proxy Routes
- Forward Proxy: `/proxy/forward?url=TARGET`
- Reverse Proxy: `/proxy/reverse`
- Auto Proxy: Automatic routing based on Host header

### Admin Panel
Access the admin panel at `http://localhost:8081`

## Load Balancing Methods

- **round_robin**: Distributes requests evenly
- **least_connections**: Routes to backend with fewest connections
- **ip_hash**: Consistent routing based on client IP
- **weighted**: Distributes based on backend weights

## Troubleshooting

### Common Issues

#### WebSocket Connection Failed
- Ensure `WEBSOCKET_ENABLED=true` in `.env`
- Check backend WebSocket endpoint configuration
- Verify PM2 is running in fork mode (not cluster)

#### Service Worker Conflicts
- The proxy automatically adds cache control headers
- Uses `Clear-Site-Data` header when switching subdomains

#### Backend Not Responding
- Check health check logs in `./logs/proxy.log`
- Verify backend URL and port
- Check firewall rules

### Debugging

Enable debug logging:
```env
LOG_LEVEL=debug
```

View logs:
```bash
# PM2 logs
pm2 logs rawr-proxy

# Application logs
tail -f ./logs/proxy.log
```

## Project Structure

```
/opt/proxy/
├── src/
│   ├── server.js              # Main server entry
│   ├── proxy/
│   │   ├── ProxyManager.js    # Core proxy logic
│   │   ├── BackendPool.js     # Load balancing
│   │   └── RequestModifier.js # Request manipulation
│   ├── auth/
│   │   └── AuthManager.js     # Authentication
│   ├── admin/
│   │   └── AdminPanel.js      # Admin interface
│   ├── database/
│   │   └── Database.js        # Database operations
│   ├── websocket/
│   │   └── WebSocketManager.js # WebSocket metrics
│   └── utils/
│       ├── Logger.js          # Logging utility
│       └── BackendHealthChecker.js
├── data/
│   └── proxy.db               # SQLite database
├── logs/
│   └── proxy.log              # Application logs
├── certs/                     # SSL certificates
├── .env                       # Configuration
├── package.json
└── ecosystem.config.js        # PM2 configuration
```

## Performance Optimization

- **Connection Pooling**: Reuses HTTP agents for backend connections
- **Proxy Instance Caching**: Caches proxy middleware instances per domain
- **Health Check Intervals**: Configurable health check frequency
- **Response Caching**: Optional caching layer for GET requests
- **WebSocket Connection Tracking**: Efficient metrics collection

## Security

- JWT-based authentication (when enabled)
- Request rate limiting support
- Domain blocking capability
- HTTPS/TLS encryption
- Header sanitization
- XSS protection via Helmet.js

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## Known Issues & Solutions

### Issue: "Server Offline Unknown" in Immich
**Solution**: Fixed by properly isolating proxy instances per domain and handling WebSocket upgrades separately from HTTP proxy middleware.

### Issue: Browser shows wrong service title
**Solution**: Implemented cache control headers and Service Worker isolation per subdomain.

## License

MIT License - See LICENSE file for details

## Support

For issues and questions:
- GitHub Issues: [Create an issue](https://github.com/yourusername/rawrproxy/issues)
- Documentation: Check the `/docs` folder

## Credits

Built with:
- [Express.js](https://expressjs.com/)
- [http-proxy-middleware](https://github.com/chimurai/http-proxy-middleware)
- [Socket.IO](https://socket.io/)
- [PM2](https://pm2.keymetrics.io/)
- [SQLite](https://www.sqlite.org/)

---

**RAWRProxy** - High-performance reverse proxy for modern web applications