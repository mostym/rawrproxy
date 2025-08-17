const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

class AdminPanel {
    constructor(app, database, logger, proxmoxIntegration, cloudflareIntegration, proxyManager = null) {
        this.app = app;
        this.db = database;
        this.logger = logger;
        this.proxmox = proxmoxIntegration;
        this.cloudflare = cloudflareIntegration;
        this.proxyManager = proxyManager;
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupViews();
    }
    
    setProxyManager(proxyManager) {
        this.proxyManager = proxyManager;
    }

    setupMiddleware() {
        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));
        this.app.use(express.static(path.join(__dirname, '../public')));
        this.app.set('view engine', 'ejs');
        this.app.set('views', path.join(__dirname, '../views'));
    }

    setupRoutes() {
        this.app.get('/', this.renderDashboard.bind(this));
        this.app.get('/domains', this.renderDomainsPage.bind(this));
        this.app.get('/websocket', this.renderWebSocketMonitor.bind(this));
        this.app.get('/api/stats', this.getStats.bind(this));
        this.app.get('/api/users', this.getUsers.bind(this));
        this.app.post('/api/users', this.createUser.bind(this));
        this.app.delete('/api/users/:id', this.deleteUser.bind(this));
        this.app.get('/api/rules', this.getRules.bind(this));
        this.app.post('/api/rules', this.createRule.bind(this));
        this.app.delete('/api/rules/:id', this.deleteRule.bind(this));
        this.app.get('/api/logs', this.getLogs.bind(this));
        this.app.get('/api/blocked-ips', this.getBlockedIps.bind(this));
        this.app.post('/api/block-ip', this.blockIp.bind(this));
        this.app.delete('/api/blocked-ips/:ip', this.unblockIp.bind(this));
        this.app.post('/api/cache/clear', this.clearCache.bind(this));
        this.app.get('/api/metrics', this.getMetrics.bind(this));
        this.app.get('/api/websocket/metrics', this.getWebSocketMetrics.bind(this));
        
        // Domain management endpoints
        this.app.get('/api/domains', this.getDomains.bind(this));
        this.app.post('/api/domains', this.createDomain.bind(this));
        this.app.delete('/api/domains/:id', this.deleteDomain.bind(this));
        this.app.get('/api/domains/:id/subdomains', this.getSubdomains.bind(this));
        this.app.post('/api/domains/:id/subdomains', this.createSubdomain.bind(this));
        
        // Backend management endpoints
        this.app.get('/api/backends', this.getBackends.bind(this));
        this.app.post('/api/backends', this.createBackend.bind(this));
        this.app.delete('/api/backends/:id', this.deleteBackend.bind(this));
        this.app.put('/api/backends/:id', this.updateBackend.bind(this));
        
        // Domain-Backend mapping endpoints
        this.app.post('/api/domains/:domainId/backends', this.assignBackend.bind(this));
        this.app.get('/api/domains/:domainId/backends', this.getDomainBackends.bind(this));
        this.app.delete('/api/domain-backends/:id', this.removeBackendAssignment.bind(this));
        
        // Proxmox integration endpoints
        this.app.get('/proxmox', this.renderProxmoxPage.bind(this));
        this.app.get('/api/proxmox/config', this.getProxmoxConfig.bind(this));
        this.app.post('/api/proxmox/config', this.saveProxmoxConfig.bind(this));
        this.app.post('/api/proxmox/test', this.testProxmoxConnection.bind(this));
        this.app.post('/api/proxmox/sync', this.syncProxmox.bind(this));
        this.app.get('/api/proxmox/resources', this.getProxmoxResources.bind(this));
        
        // Cloudflare integration endpoints
        this.app.get('/cloudflare', this.renderCloudflarePage.bind(this));
        this.app.get('/api/cloudflare/config', this.getCloudflareConfig.bind(this));
        this.app.post('/api/cloudflare/config', this.saveCloudflareConfig.bind(this));
        this.app.post('/api/cloudflare/test', this.testCloudflareConnection.bind(this));
        this.app.post('/api/cloudflare/sync', this.syncCloudflare.bind(this));
        this.app.get('/api/cloudflare/zones', this.getCloudflareZones.bind(this));
        this.app.post('/api/cloudflare/dns', this.createDNSRecord.bind(this));
        this.app.post('/api/cloudflare/ssl', this.generateSSLCertificate.bind(this));
        this.app.post('/api/cloudflare/tunnel', this.createCloudflareTunnel.bind(this));
    }

    setupViews() {
        
    }

    async renderDashboard(req, res) {
        try {
            const stats = await this.getSystemStats();
            res.render('dashboard', {
                title: 'Proxy Admin Dashboard',
                stats,
                message: 'Use the API endpoints to manage the proxy server'
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async renderDomainsPage(req, res) {
        try {
            res.sendFile(path.join(__dirname, '../views/domains-enhanced.html'));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async renderWebSocketMonitor(req, res) {
        try {
            res.sendFile(path.join(__dirname, '../views/websocket-enhanced.html'));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getStats(req, res) {
        try {
            const stats = await this.getSystemStats();
            res.json(stats);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getSystemStats() {
        const now = new Date();
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
        
        const metrics = await this.db.getMetrics(dayAgo.toISOString(), now.toISOString());
        const users = await this.db.all('SELECT COUNT(*) as count FROM users');
        const rules = await this.db.all('SELECT COUNT(*) as count FROM proxy_rules WHERE active = 1');
        const blockedIps = await this.db.all('SELECT COUNT(*) as count FROM blocked_ips');
        
        // Get real domain and backend counts
        const domains = await this.db.all('SELECT COUNT(*) as count FROM domains WHERE active = 1');
        const subdomains = await this.db.all('SELECT COUNT(*) as count FROM subdomains WHERE active = 1');
        const backends = await this.db.all('SELECT COUNT(*) as count FROM backends WHERE active = 1');
        const healthyBackends = await this.db.all('SELECT COUNT(*) as count FROM backends WHERE active = 1 AND healthy = 1');
        const proxmoxResources = await this.db.all('SELECT COUNT(*) as count FROM proxmox_resources');
        
        // Calculate total requests from metrics
        let totalRequests = 0;
        if (metrics && metrics.length > 0) {
            totalRequests = metrics.reduce((sum, m) => sum + (m.requests || 0), 0);
        }
        
        return {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cpu: process.cpuUsage(),
            totalUsers: users[0].count,
            activeRules: rules[0].count,
            blockedIps: blockedIps[0].count,
            domains: domains[0].count,
            subdomains: subdomains[0].count,
            backends: backends[0].count,
            healthyBackends: healthyBackends[0].count,
            proxmoxResources: proxmoxResources[0].count,
            totalRequests: totalRequests,
            dailyMetrics: metrics
        };
    }

    async getUsers(req, res) {
        try {
            const users = await this.db.all('SELECT id, username, email, createdAt, lastLogin FROM users');
            res.json(users);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async createUser(req, res) {
        try {
            const { username, password, email } = req.body;
            const bcrypt = require('bcrypt');
            const hashedPassword = await bcrypt.hash(password, 10);
            
            const user = await this.db.createUser({
                username,
                password: hashedPassword,
                email,
                createdAt: new Date().toISOString()
            });
            
            res.json({ message: 'User created', user });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async deleteUser(req, res) {
        try {
            await this.db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
            res.json({ message: 'User deleted' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getRules(req, res) {
        try {
            const rules = await this.db.getProxyRules();
            res.json(rules);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async createRule(req, res) {
        try {
            const rule = await this.db.addProxyRule(req.body);
            res.json({ message: 'Rule created', rule });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async deleteRule(req, res) {
        try {
            await this.db.run('UPDATE proxy_rules SET active = 0 WHERE id = ?', [req.params.id]);
            res.json({ message: 'Rule deactivated' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getLogs(req, res) {
        try {
            const limit = req.query.limit || 100;
            const logs = await this.db.all(
                'SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT ?',
                [limit]
            );
            res.json(logs);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getBlockedIps(req, res) {
        try {
            const blockedIps = await this.db.all('SELECT * FROM blocked_ips');
            res.json(blockedIps);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async blockIp(req, res) {
        try {
            const { ip, reason, duration } = req.body;
            await this.db.blockIp(ip, reason, duration);
            res.json({ message: 'IP blocked', ip });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async unblockIp(req, res) {
        try {
            await this.db.run('DELETE FROM blocked_ips WHERE ip = ?', [req.params.ip]);
            res.json({ message: 'IP unblocked' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async clearCache(req, res) {
        res.json({ message: 'Cache clearing not implemented in this version' });
    }

    async getWebSocketMetrics(req, res) {
        try {
            const metrics = this.proxyManager ? this.proxyManager.wsManager.getMetrics() : {
                totalConnections: 0,
                activeConnections: 0,
                messagesProxied: 0,
                bytesTransferred: 0,
                errors: 0,
                connectionsByBackend: [],
                pools: [],
                activeConnectionDetails: []
            };
            res.json(metrics);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getMetrics(req, res) {
        try {
            const startTime = req.query.start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const endTime = req.query.end || new Date().toISOString();
            
            const metrics = await this.db.getMetrics(startTime, endTime);
            res.json(metrics);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    // Domain management methods
    async getDomains(req, res) {
        try {
            const domains = await this.db.getDomains();
            res.json(domains);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async createDomain(req, res) {
        try {
            const { domain, type = 'reverse' } = req.body;
            if (!domain) {
                return res.status(400).json({ error: 'Domain is required' });
            }
            
            const result = await this.db.createDomain(domain, type);
            res.json({ message: 'Domain created', id: result.id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async deleteDomain(req, res) {
        try {
            await this.db.run('UPDATE domains SET active = 0 WHERE id = ?', [req.params.id]);
            res.json({ message: 'Domain deleted' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getSubdomains(req, res) {
        try {
            const subdomains = await this.db.getSubdomains(req.params.id);
            res.json(subdomains);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async createSubdomain(req, res) {
        try {
            const { subdomain, pathPrefix, stripPath } = req.body;
            if (!subdomain) {
                return res.status(400).json({ error: 'Subdomain is required' });
            }
            
            const domainId = req.params.id;
            const result = await this.db.createSubdomain(
                domainId,
                subdomain,
                pathPrefix,
                stripPath
            );
            
            // Auto-link backend if one exists with matching name
            // Get the domain to construct the full subdomain name
            const domain = await this.db.get('SELECT domain FROM domains WHERE id = ?', [domainId]);
            if (domain) {
                const fullSubdomainName = `${subdomain}.${domain.domain}`;
                
                // Look for backends with matching names
                const matchingBackends = await this.db.all(
                    'SELECT * FROM backends WHERE (name = ? OR name = ?) AND active = 1',
                    [subdomain, fullSubdomainName]
                );
                
                if (matchingBackends.length > 0) {
                    // Link the first matching backend to this subdomain
                    await this.db.assignBackendToDomain(
                        domainId,
                        matchingBackends[0].id,
                        result.id,
                        'round_robin'
                    );
                    this.logger.info(`Auto-linked backend ${matchingBackends[0].name} to subdomain ${fullSubdomainName}`);
                }
            }
            
            res.json({ message: 'Subdomain created', id: result.id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    // Backend management methods
    async getBackends(req, res) {
        try {
            const backends = await this.db.getBackends();
            res.json(backends);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async createBackend(req, res) {
        try {
            const { name, url, type, weight, healthCheckPath, domainId, subdomainId } = req.body;
            if (!name || !url) {
                return res.status(400).json({ error: 'Name and URL are required' });
            }
            
            const result = await this.db.createBackend({
                name,
                url,
                type: type || 'internal',
                weight: weight || 1,
                healthCheckPath: healthCheckPath || '/health'
            });
            
            // If a domain/subdomain was specified, automatically link the backend
            if (domainId) {
                await this.db.assignBackendToDomain(
                    domainId,
                    result.id,
                    subdomainId || null,
                    'round_robin'
                );
            } else {
                // Try to auto-link based on subdomain name match
                // First check if name is just a subdomain (e.g., "pve")
                let subdomain = await this.db.get(
                    'SELECT s.*, d.domain FROM subdomains s JOIN domains d ON s.domainId = d.id WHERE s.subdomain = ?',
                    [name]
                );
                
                // If not found, check if name is a full subdomain (e.g., "pve.25bc.com")
                if (!subdomain && name.includes('.')) {
                    const parts = name.split('.');
                    const subdomainPart = parts[0];
                    const domainPart = parts.slice(1).join('.');
                    
                    subdomain = await this.db.get(
                        'SELECT s.*, d.domain FROM subdomains s JOIN domains d ON s.domainId = d.id WHERE s.subdomain = ? AND d.domain = ?',
                        [subdomainPart, domainPart]
                    );
                }
                
                if (subdomain) {
                    await this.db.assignBackendToDomain(
                        subdomain.domainId,
                        result.id,
                        subdomain.id,
                        'round_robin'
                    );
                    this.logger.info(`Auto-linked backend "${name}" to subdomain ${subdomain.subdomain}.${subdomain.domain}`);
                }
            }
            
            res.json({ message: 'Backend created', id: result.id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async deleteBackend(req, res) {
        try {
            // First remove all domain assignments for this backend
            await this.db.run('DELETE FROM domain_backends WHERE backendId = ?', [req.params.id]);
            // Then soft delete the backend
            await this.db.run('UPDATE backends SET active = 0 WHERE id = ?', [req.params.id]);
            res.json({ message: 'Backend deleted' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async updateBackend(req, res) {
        try {
            const { name, url, type, weight, healthCheckPath, healthy } = req.body;
            const updates = [];
            const params = [];
            
            if (name) { updates.push('name = ?'); params.push(name); }
            if (url) { updates.push('url = ?'); params.push(url); }
            if (type) { updates.push('type = ?'); params.push(type); }
            if (weight) { updates.push('weight = ?'); params.push(weight); }
            if (healthCheckPath) { updates.push('health_check_path = ?'); params.push(healthCheckPath); }
            if (healthy !== undefined) { updates.push('healthy = ?'); params.push(healthy ? 1 : 0); }
            
            if (updates.length === 0) {
                return res.status(400).json({ error: 'No updates provided' });
            }
            
            params.push(req.params.id);
            await this.db.run(
                `UPDATE backends SET ${updates.join(', ')} WHERE id = ?`,
                params
            );
            
            res.json({ message: 'Backend updated' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async assignBackend(req, res) {
        try {
            const { backendId, subdomainId, loadBalanceMethod } = req.body;
            if (!backendId) {
                return res.status(400).json({ error: 'Backend ID is required' });
            }
            
            const result = await this.db.assignBackendToDomain(
                req.params.domainId,
                backendId,
                subdomainId,
                loadBalanceMethod || 'round_robin'
            );
            res.json({ message: 'Backend assigned', id: result.id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getDomainBackends(req, res) {
        try {
            // Use getAllBackendsForDomain to show all backends including unhealthy ones in admin
            const backends = await this.db.getAllBackendsForDomain(req.params.domainId);
            res.json(backends);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async removeBackendAssignment(req, res) {
        try {
            await this.db.run('DELETE FROM domain_backends WHERE id = ?', [req.params.id]);
            res.json({ message: 'Backend assignment removed' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    // Proxmox integration methods
    async renderProxmoxPage(req, res) {
        try {
            res.sendFile(path.join(__dirname, '../views/proxmox-modern.html'));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getProxmoxConfig(req, res) {
        try {
            const config = await this.db.get('SELECT * FROM proxmox_config LIMIT 1');
            res.json(config || {});
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async saveProxmoxConfig(req, res) {
        try {
            const { host, port, username, password, realm, domain, syncInterval, autoCreateDomains, namingPattern } = req.body;
            
            if (!host || !username || !password) {
                return res.status(400).json({ error: 'Host, username, and password are required' });
            }
            
            // Check if config exists
            const existing = await this.db.get('SELECT id FROM proxmox_config LIMIT 1');
            
            if (existing) {
                await this.db.run(
                    `UPDATE proxmox_config SET 
                    host = ?, port = ?, username = ?, realm = ?, domain = ?,
                    sync_interval = ?, auto_create_domains = ?, naming_pattern = ?, enabled = 1
                    WHERE id = ?`,
                    [host, port || 8006, username, realm || 'pam', domain || 'local',
                     syncInterval || 60000, autoCreateDomains ? 1 : 0, namingPattern || '{name}.{domain}',
                     existing.id]
                );
            } else {
                await this.db.run(
                    `INSERT INTO proxmox_config 
                    (host, port, username, realm, domain, sync_interval, auto_create_domains, naming_pattern, enabled, createdAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
                    [host, port || 8006, username, realm || 'pam', domain || 'local',
                     syncInterval || 60000, autoCreateDomains ? 1 : 0, namingPattern || '{name}.{domain}',
                     new Date().toISOString()]
                );
            }
            
            // Reinitialize Proxmox integration with new config
            const config = {
                host,
                port: port || 8006,
                username,
                password,
                realm: realm || 'pam',
                domain: domain || 'local',
                syncInterval: syncInterval || 60000,
                autoCreateDomains: autoCreateDomains || false,
                namingPattern: namingPattern || '{name}.{domain}'
            };
            
            await this.proxmox.initialize(config);
            
            res.json({ message: 'Proxmox configuration saved and initialized' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async testProxmoxConnection(req, res) {
        try {
            const { host, port, username, password, realm } = req.body;
            
            if (!host || !username || !password) {
                return res.status(400).json({ error: 'Host, username, and password are required' });
            }
            
            const config = {
                host,
                port: port || 8006,
                username,
                password,
                realm: realm || 'pam'
            };
            
            await this.proxmox.initialize(config);
            const result = await this.proxmox.testConnection();
            
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async syncProxmox(req, res) {
        try {
            const result = await this.proxmox.manualSync();
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getProxmoxResources(req, res) {
        try {
            const resources = await this.db.all(
                `SELECT pr.*, b.url as backend_url, b.healthy 
                FROM proxmox_resources pr 
                LEFT JOIN backends b ON pr.backend_id = b.id 
                ORDER BY pr.name`
            );
            res.json(resources);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    // Cloudflare integration methods
    async renderCloudflarePage(req, res) {
        try {
            res.sendFile(path.join(__dirname, '../views/cloudflare-modern.html'));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getCloudflareConfig(req, res) {
        try {
            const config = await this.db.get('SELECT * FROM cloudflare_config LIMIT 1');
            res.json(config || {});
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async saveCloudflareConfig(req, res) {
        try {
            const { email, apiKey, apiToken, accountId, tunnelEnabled, autoSSL, autoDNS, proxied } = req.body;
            
            if (!apiToken && (!email || !apiKey)) {
                return res.status(400).json({ error: 'API Token or Email/API Key required' });
            }
            
            const existing = await this.db.get('SELECT id FROM cloudflare_config LIMIT 1');
            
            if (existing) {
                await this.db.run(
                    `UPDATE cloudflare_config SET 
                    email = ?, api_key = ?, api_token = ?, account_id = ?,
                    tunnel_enabled = ?, auto_ssl = ?, auto_dns = ?, proxied = ?, enabled = 1
                    WHERE id = ?`,
                    [email, apiKey, apiToken, accountId,
                     tunnelEnabled ? 1 : 0, autoSSL ? 1 : 0, autoDNS ? 1 : 0, proxied ? 1 : 0,
                     existing.id]
                );
            } else {
                await this.db.run(
                    `INSERT INTO cloudflare_config 
                    (email, api_key, api_token, account_id, tunnel_enabled, auto_ssl, auto_dns, proxied, enabled, createdAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
                    [email, apiKey, apiToken, accountId,
                     tunnelEnabled ? 1 : 0, autoSSL ? 1 : 0, autoDNS ? 1 : 0, proxied ? 1 : 0,
                     new Date().toISOString()]
                );
            }
            
            const config = { email, apiKey, apiToken, accountId, tunnelEnabled, autoSSL, autoDNS, proxied };
            await this.cloudflare.initialize(config);
            
            res.json({ message: 'Cloudflare configuration saved' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async testCloudflareConnection(req, res) {
        try {
            const { email, apiKey, apiToken } = req.body;
            
            const config = { email, apiKey, apiToken };
            await this.cloudflare.initialize(config);
            
            const zones = await this.cloudflare.getZones();
            res.json({ success: true, zones: zones.length, message: `Connected! Found ${zones.length} zone(s)` });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async syncCloudflare(req, res) {
        try {
            const domains = await this.db.getDomains();
            const result = await this.cloudflare.syncDomainsWithCloudflare(domains);
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getCloudflareZones(req, res) {
        try {
            const zones = await this.cloudflare.getZones();
            res.json(zones);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async createDNSRecord(req, res) {
        try {
            const { domain, type, content, proxied } = req.body;
            const record = await this.cloudflare.createDNSRecord(domain, type, content, proxied);
            res.json(record);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async generateSSLCertificate(req, res) {
        try {
            const { domain } = req.body;
            const cert = await this.cloudflare.generateOriginCertificate(domain);
            res.json(cert);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async createCloudflareTunnel(req, res) {
        try {
            const { name, domain } = req.body;
            const tunnel = await this.cloudflare.setupCloudflaredTunnel(name, domain);
            res.json(tunnel);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = AdminPanel;