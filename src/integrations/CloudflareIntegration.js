const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

class CloudflareIntegration {
    constructor(database, logger) {
        this.db = database;
        this.logger = logger;
        this.apiBase = 'https://api.cloudflare.com/client/v4';
        this.config = null;
        this.zoneCache = new Map();
    }

    async initialize(config) {
        this.config = config || {
            email: process.env.CLOUDFLARE_EMAIL,
            apiKey: process.env.CLOUDFLARE_API_KEY,
            apiToken: process.env.CLOUDFLARE_API_TOKEN,
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
            tunnelEnabled: process.env.CLOUDFLARE_TUNNEL_ENABLED === 'true',
            tunnelId: process.env.CLOUDFLARE_TUNNEL_ID,
            autoSSL: process.env.CLOUDFLARE_AUTO_SSL === 'true',
            autoDNS: process.env.CLOUDFLARE_AUTO_DNS === 'true',
            proxied: process.env.CLOUDFLARE_PROXIED !== 'false'
        };

        if (!this.config.apiToken && (!this.config.email || !this.config.apiKey)) {
            this.logger.warn('Cloudflare integration not configured - missing API credentials');
            return false;
        }

        // Setup axios instance with auth headers
        this.axiosInstance = axios.create({
            baseURL: this.apiBase,
            headers: this.getAuthHeaders()
        });

        try {
            await this.verifyCredentials();
            this.logger.info('Cloudflare integration initialized successfully');
            return true;
        } catch (error) {
            this.logger.error(`Failed to initialize Cloudflare integration: ${error.message}`);
            return false;
        }
    }

    getAuthHeaders() {
        if (this.config.apiToken) {
            return {
                'Authorization': `Bearer ${this.config.apiToken}`,
                'Content-Type': 'application/json'
            };
        } else {
            return {
                'X-Auth-Email': this.config.email,
                'X-Auth-Key': this.config.apiKey,
                'Content-Type': 'application/json'
            };
        }
    }

    async verifyCredentials() {
        try {
            const response = await this.axiosInstance.get('/user/tokens/verify');
            this.logger.info('Cloudflare API credentials verified');
            return response.data.result;
        } catch (error) {
            // Try zones endpoint as fallback
            const zonesResponse = await this.axiosInstance.get('/zones?per_page=1');
            if (zonesResponse.data.success) {
                this.logger.info('Cloudflare API credentials verified via zones endpoint');
                return true;
            }
            throw error;
        }
    }

    async getZones() {
        try {
            const response = await this.axiosInstance.get('/zones?per_page=100');
            if (response.data.success) {
                const zones = response.data.result;
                // Cache zones for quick lookup
                zones.forEach(zone => {
                    this.zoneCache.set(zone.name, zone);
                });
                return zones;
            }
            throw new Error(response.data.errors?.[0]?.message || 'Failed to get zones');
        } catch (error) {
            this.logger.error(`Failed to get Cloudflare zones: ${error.message}`);
            throw error;
        }
    }

    async getZoneForDomain(domain) {
        // Check cache first
        if (this.zoneCache.has(domain)) {
            return this.zoneCache.get(domain);
        }

        // Find the zone that matches this domain
        const zones = await this.getZones();
        
        // Try exact match first
        let zone = zones.find(z => z.name === domain);
        
        // Try to find parent domain
        if (!zone) {
            const parts = domain.split('.');
            for (let i = 1; i < parts.length; i++) {
                const parentDomain = parts.slice(i).join('.');
                zone = zones.find(z => z.name === parentDomain);
                if (zone) break;
            }
        }
        
        return zone;
    }

    async createDNSRecord(domain, type, content, proxied = null, ttl = 1) {
        try {
            const zone = await this.getZoneForDomain(domain);
            if (!zone) {
                throw new Error(`No Cloudflare zone found for domain ${domain}`);
            }

            const recordName = domain;
            const useProxied = proxied !== null ? proxied : this.config.proxied;

            const data = {
                type,
                name: recordName,
                content,
                ttl: useProxied ? 1 : ttl, // TTL must be 1 for proxied records
                proxied: useProxied
            };

            const response = await this.axiosInstance.post(
                `/zones/${zone.id}/dns_records`,
                data
            );

            if (response.data.success) {
                this.logger.info(`Created DNS ${type} record for ${domain}`);
                return response.data.result;
            }
            
            throw new Error(response.data.errors?.[0]?.message || 'Failed to create DNS record');
        } catch (error) {
            this.logger.error(`Failed to create DNS record: ${error.message}`);
            throw error;
        }
    }

    async updateDNSRecord(domain, type, content, proxied = null) {
        try {
            const zone = await this.getZoneForDomain(domain);
            if (!zone) {
                throw new Error(`No Cloudflare zone found for domain ${domain}`);
            }

            // Find existing record
            const recordsResponse = await this.axiosInstance.get(
                `/zones/${zone.id}/dns_records?name=${domain}&type=${type}`
            );

            if (!recordsResponse.data.success || recordsResponse.data.result.length === 0) {
                // No existing record, create new one
                return this.createDNSRecord(domain, type, content, proxied);
            }

            const record = recordsResponse.data.result[0];
            const useProxied = proxied !== null ? proxied : this.config.proxied;

            const response = await this.axiosInstance.put(
                `/zones/${zone.id}/dns_records/${record.id}`,
                {
                    type,
                    name: domain,
                    content,
                    ttl: useProxied ? 1 : record.ttl,
                    proxied: useProxied
                }
            );

            if (response.data.success) {
                this.logger.info(`Updated DNS ${type} record for ${domain}`);
                return response.data.result;
            }
            
            throw new Error(response.data.errors?.[0]?.message || 'Failed to update DNS record');
        } catch (error) {
            this.logger.error(`Failed to update DNS record: ${error.message}`);
            throw error;
        }
    }

    async deleteDNSRecord(domain, type) {
        try {
            const zone = await this.getZoneForDomain(domain);
            if (!zone) {
                throw new Error(`No Cloudflare zone found for domain ${domain}`);
            }

            const recordsResponse = await this.axiosInstance.get(
                `/zones/${zone.id}/dns_records?name=${domain}&type=${type}`
            );

            if (!recordsResponse.data.success || recordsResponse.data.result.length === 0) {
                this.logger.warn(`No DNS record found for ${domain} (${type})`);
                return false;
            }

            const record = recordsResponse.data.result[0];
            
            const response = await this.axiosInstance.delete(
                `/zones/${zone.id}/dns_records/${record.id}`
            );

            if (response.data.success) {
                this.logger.info(`Deleted DNS ${type} record for ${domain}`);
                return true;
            }
            
            throw new Error(response.data.errors?.[0]?.message || 'Failed to delete DNS record');
        } catch (error) {
            this.logger.error(`Failed to delete DNS record: ${error.message}`);
            throw error;
        }
    }

    async getSSLCertificate(domain) {
        try {
            const zone = await this.getZoneForDomain(domain);
            if (!zone) {
                throw new Error(`No Cloudflare zone found for domain ${domain}`);
            }

            // Get SSL/TLS settings
            const response = await this.axiosInstance.get(
                `/zones/${zone.id}/ssl/certificate_packs`
            );

            if (response.data.success) {
                return response.data.result;
            }
            
            throw new Error(response.data.errors?.[0]?.message || 'Failed to get SSL certificate');
        } catch (error) {
            this.logger.error(`Failed to get SSL certificate: ${error.message}`);
            throw error;
        }
    }

    async enableUniversalSSL(domain) {
        try {
            const zone = await this.getZoneForDomain(domain);
            if (!zone) {
                throw new Error(`No Cloudflare zone found for domain ${domain}`);
            }

            // Enable Universal SSL
            const response = await this.axiosInstance.patch(
                `/zones/${zone.id}/settings/ssl`,
                { value: 'flexible' } // or 'full' for end-to-end encryption
            );

            if (response.data.success) {
                this.logger.info(`Enabled Universal SSL for ${domain}`);
                return response.data.result;
            }
            
            throw new Error(response.data.errors?.[0]?.message || 'Failed to enable SSL');
        } catch (error) {
            this.logger.error(`Failed to enable SSL: ${error.message}`);
            throw error;
        }
    }

    async generateOriginCertificate(domain, validityDays = 365) {
        try {
            const response = await this.axiosInstance.post(
                '/certificates',
                {
                    hostnames: [domain, `*.${domain}`],
                    requested_validity: validityDays,
                    request_type: 'origin-rsa',
                    csr: null // Let Cloudflare generate the private key
                }
            );

            if (response.data.success) {
                const cert = response.data.result;
                
                // Save certificate and key to files
                const certsDir = path.join(process.cwd(), 'certs', 'cloudflare');
                await fs.mkdir(certsDir, { recursive: true });
                
                const certPath = path.join(certsDir, `${domain}.crt`);
                const keyPath = path.join(certsDir, `${domain}.key`);
                
                await fs.writeFile(certPath, cert.certificate);
                await fs.writeFile(keyPath, cert.private_key);
                
                this.logger.info(`Generated and saved origin certificate for ${domain}`);
                
                return {
                    certificate: cert.certificate,
                    privateKey: cert.private_key,
                    certPath,
                    keyPath,
                    expiresOn: cert.expires_on
                };
            }
            
            throw new Error(response.data.errors?.[0]?.message || 'Failed to generate certificate');
        } catch (error) {
            this.logger.error(`Failed to generate origin certificate: ${error.message}`);
            throw error;
        }
    }

    async setupCloudflaredTunnel(tunnelName, domain) {
        try {
            if (!this.config.accountId) {
                throw new Error('Cloudflare account ID is required for tunnel setup');
            }

            // Create tunnel
            const createResponse = await this.axiosInstance.post(
                `/accounts/${this.config.accountId}/tunnels`,
                {
                    name: tunnelName,
                    tunnel_secret: this.generateTunnelSecret()
                }
            );

            if (!createResponse.data.success) {
                throw new Error(createResponse.data.errors?.[0]?.message || 'Failed to create tunnel');
            }

            const tunnel = createResponse.data.result;
            
            // Create DNS record for tunnel
            await this.createDNSRecord(
                domain,
                'CNAME',
                `${tunnel.id}.cfargotunnel.com`,
                true // Always proxy tunnel records
            );

            // Save tunnel credentials
            const tunnelDir = path.join(process.cwd(), 'tunnels');
            await fs.mkdir(tunnelDir, { recursive: true });
            
            const credentialsPath = path.join(tunnelDir, `${tunnel.id}.json`);
            await fs.writeFile(credentialsPath, JSON.stringify({
                AccountTag: this.config.accountId,
                TunnelSecret: tunnel.tunnel_secret,
                TunnelID: tunnel.id,
                TunnelName: tunnel.name
            }, null, 2));

            this.logger.info(`Created Cloudflare Tunnel: ${tunnelName}`);
            
            return {
                id: tunnel.id,
                name: tunnel.name,
                secret: tunnel.tunnel_secret,
                credentialsPath,
                hostname: `${tunnel.id}.cfargotunnel.com`
            };
        } catch (error) {
            this.logger.error(`Failed to setup Cloudflare Tunnel: ${error.message}`);
            throw error;
        }
    }

    generateTunnelSecret() {
        const crypto = require('crypto');
        return crypto.randomBytes(32).toString('base64');
    }

    async runCloudflaredTunnel(tunnelId, config) {
        try {
            const configPath = path.join(process.cwd(), 'tunnels', `${tunnelId}-config.yml`);
            
            // Create tunnel configuration
            const tunnelConfig = {
                tunnel: tunnelId,
                credentials_file: path.join(process.cwd(), 'tunnels', `${tunnelId}.json`),
                ingress: config.ingress || [
                    {
                        hostname: config.hostname,
                        service: config.service || 'http://localhost:80'
                    },
                    {
                        service: 'http_status:404'
                    }
                ]
            };

            await fs.writeFile(configPath, this.yamlStringify(tunnelConfig));

            // Start cloudflared
            const cloudflared = spawn('cloudflared', [
                'tunnel',
                '--config', configPath,
                'run'
            ], {
                detached: true,
                stdio: 'ignore'
            });

            cloudflared.unref();
            
            this.logger.info(`Started Cloudflare Tunnel ${tunnelId}`);
            
            return {
                pid: cloudflared.pid,
                configPath
            };
        } catch (error) {
            this.logger.error(`Failed to run Cloudflare Tunnel: ${error.message}`);
            throw error;
        }
    }

    yamlStringify(obj, indent = 0) {
        let yaml = '';
        const spaces = '  '.repeat(indent);
        
        for (const [key, value] of Object.entries(obj)) {
            yaml += `${spaces}${key}:`;
            
            if (Array.isArray(value)) {
                yaml += '\n';
                value.forEach(item => {
                    if (typeof item === 'object') {
                        yaml += `${spaces}- \n`;
                        const itemYaml = this.yamlStringify(item, indent + 2);
                        yaml += itemYaml.split('\n').map(line => 
                            line ? `${spaces}  ${line}` : ''
                        ).join('\n');
                    } else {
                        yaml += `${spaces}- ${item}\n`;
                    }
                });
            } else if (typeof value === 'object' && value !== null) {
                yaml += '\n' + this.yamlStringify(value, indent + 1);
            } else {
                yaml += ` ${value}\n`;
            }
        }
        
        return yaml;
    }

    async syncDomainsWithCloudflare(domains) {
        const results = {
            created: [],
            updated: [],
            failed: [],
            certificates: []
        };

        for (const domain of domains) {
            try {
                // Get public IP for A record
                const publicIP = await this.getPublicIP();
                
                if (this.config.autoDNS) {
                    // Create or update DNS A record
                    await this.updateDNSRecord(
                        domain.domain,
                        'A',
                        publicIP,
                        domain.proxied !== false
                    );
                    results.updated.push(domain.domain);
                    
                    // Create CNAME records for subdomains
                    const subdomains = await this.db.getSubdomains(domain.id);
                    for (const subdomain of subdomains) {
                        const fullDomain = `${subdomain.subdomain}.${domain.domain}`;
                        await this.updateDNSRecord(
                            fullDomain,
                            'CNAME',
                            domain.domain,
                            domain.proxied !== false
                        );
                        results.created.push(fullDomain);
                    }
                }
                
                if (this.config.autoSSL) {
                    // Enable SSL for the domain
                    await this.enableUniversalSSL(domain.domain);
                    
                    // Generate origin certificate if needed
                    if (domain.origin_certificate) {
                        const cert = await this.generateOriginCertificate(domain.domain);
                        results.certificates.push({
                            domain: domain.domain,
                            certPath: cert.certPath,
                            keyPath: cert.keyPath,
                            expiresOn: cert.expiresOn
                        });
                    }
                }
            } catch (error) {
                results.failed.push({
                    domain: domain.domain,
                    error: error.message
                });
            }
        }
        
        return results;
    }

    async getPublicIP() {
        try {
            const response = await axios.get('https://api.ipify.org?format=json');
            return response.data.ip;
        } catch (error) {
            this.logger.error(`Failed to get public IP: ${error.message}`);
            // Fallback to configured IP
            return process.env.PUBLIC_IP || '0.0.0.0';
        }
    }

    async getPageRules(domain) {
        try {
            const zone = await this.getZoneForDomain(domain);
            if (!zone) {
                throw new Error(`No Cloudflare zone found for domain ${domain}`);
            }

            const response = await this.axiosInstance.get(
                `/zones/${zone.id}/pagerules`
            );

            if (response.data.success) {
                return response.data.result;
            }
            
            throw new Error(response.data.errors?.[0]?.message || 'Failed to get page rules');
        } catch (error) {
            this.logger.error(`Failed to get page rules: ${error.message}`);
            throw error;
        }
    }

    async createPageRule(domain, url, actions) {
        try {
            const zone = await this.getZoneForDomain(domain);
            if (!zone) {
                throw new Error(`No Cloudflare zone found for domain ${domain}`);
            }

            const response = await this.axiosInstance.post(
                `/zones/${zone.id}/pagerules`,
                {
                    targets: [{ target: 'url', constraint: { operator: 'matches', value: url } }],
                    actions,
                    priority: 1,
                    status: 'active'
                }
            );

            if (response.data.success) {
                this.logger.info(`Created page rule for ${url}`);
                return response.data.result;
            }
            
            throw new Error(response.data.errors?.[0]?.message || 'Failed to create page rule');
        } catch (error) {
            this.logger.error(`Failed to create page rule: ${error.message}`);
            throw error;
        }
    }

    async enableAlwaysHTTPS(domain) {
        return this.createPageRule(
            domain,
            `http://*${domain}/*`,
            [{ id: 'always_use_https' }]
        );
    }

    async setSSLMode(domain, mode = 'full') {
        try {
            const zone = await this.getZoneForDomain(domain);
            if (!zone) {
                throw new Error(`No Cloudflare zone found for domain ${domain}`);
            }

            const response = await this.axiosInstance.patch(
                `/zones/${zone.id}/settings/ssl`,
                { value: mode } // off, flexible, full, full_strict
            );

            if (response.data.success) {
                this.logger.info(`Set SSL mode to ${mode} for ${domain}`);
                return response.data.result;
            }
            
            throw new Error(response.data.errors?.[0]?.message || 'Failed to set SSL mode');
        } catch (error) {
            this.logger.error(`Failed to set SSL mode: ${error.message}`);
            throw error;
        }
    }
}

module.exports = CloudflareIntegration;