const axios = require('axios');
const https = require('https');

class ProxmoxIntegration {
    constructor(database, logger) {
        this.db = database;
        this.logger = logger;
        this.proxmoxNodes = [];
        this.syncInterval = null;
        
        // Create axios instance that ignores SSL certificate errors (for self-signed certs)
        this.axiosInstance = axios.create({
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            })
        });
    }

    async initialize(config) {
        this.config = config || {
            host: process.env.PROXMOX_HOST,
            port: process.env.PROXMOX_PORT || 8006,
            username: process.env.PROXMOX_USERNAME,
            password: process.env.PROXMOX_PASSWORD,
            realm: process.env.PROXMOX_REALM || 'pam',
            domain: process.env.PROXMOX_DOMAIN || 'local',
            syncInterval: parseInt(process.env.PROXMOX_SYNC_INTERVAL) || 60000,
            autoCreateDomains: process.env.PROXMOX_AUTO_CREATE === 'true',
            namingPattern: process.env.PROXMOX_NAMING_PATTERN || '{name}.{domain}'
        };

        if (!this.config.host || !this.config.username || !this.config.password) {
            this.logger.warn('Proxmox integration not configured - missing credentials');
            return false;
        }

        try {
            await this.authenticate();
            await this.startSync();
            this.logger.info('Proxmox integration initialized successfully');
            return true;
        } catch (error) {
            this.logger.error(`Failed to initialize Proxmox integration: ${error.message}`);
            return false;
        }
    }

    async authenticate() {
        try {
            const response = await this.axiosInstance.post(
                `https://${this.config.host}:${this.config.port}/api2/json/access/ticket`,
                `username=${this.config.username}@${this.config.realm}&password=${this.config.password}`,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            this.authTicket = response.data.data.ticket;
            this.csrfToken = response.data.data.CSRFPreventionToken;
            
            // Update axios instance with auth headers
            this.axiosInstance.defaults.headers.common['Cookie'] = `PVEAuthCookie=${this.authTicket}`;
            this.axiosInstance.defaults.headers.common['CSRFPreventionToken'] = this.csrfToken;
            
            this.logger.info('Successfully authenticated with Proxmox');
            return true;
        } catch (error) {
            this.logger.error(`Proxmox authentication failed: ${error.message}`);
            throw error;
        }
    }

    async getNodes() {
        try {
            const response = await this.axiosInstance.get(
                `https://${this.config.host}:${this.config.port}/api2/json/nodes`
            );
            return response.data.data;
        } catch (error) {
            this.logger.error(`Failed to get Proxmox nodes: ${error.message}`);
            throw error;
        }
    }

    async getVMs(node) {
        try {
            const response = await this.axiosInstance.get(
                `https://${this.config.host}:${this.config.port}/api2/json/nodes/${node}/qemu`
            );
            return response.data.data || [];
        } catch (error) {
            this.logger.error(`Failed to get VMs from node ${node}: ${error.message}`);
            return [];
        }
    }

    async getContainers(node) {
        try {
            const response = await this.axiosInstance.get(
                `https://${this.config.host}:${this.config.port}/api2/json/nodes/${node}/lxc`
            );
            return response.data.data || [];
        } catch (error) {
            this.logger.error(`Failed to get containers from node ${node}: ${error.message}`);
            return [];
        }
    }

    async getVMConfig(node, vmid) {
        try {
            const response = await this.axiosInstance.get(
                `https://${this.config.host}:${this.config.port}/api2/json/nodes/${node}/qemu/${vmid}/config`
            );
            return response.data.data;
        } catch (error) {
            this.logger.error(`Failed to get VM config for ${vmid}: ${error.message}`);
            return null;
        }
    }

    async getContainerConfig(node, vmid) {
        try {
            const response = await this.axiosInstance.get(
                `https://${this.config.host}:${this.config.port}/api2/json/nodes/${node}/lxc/${vmid}/config`
            );
            return response.data.data;
        } catch (error) {
            this.logger.error(`Failed to get container config for ${vmid}: ${error.message}`);
            return null;
        }
    }

    async getVMInterfaces(node, vmid) {
        try {
            const response = await this.axiosInstance.get(
                `https://${this.config.host}:${this.config.port}/api2/json/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`
            );
            return response.data.data?.result || [];
        } catch (error) {
            // QEMU agent might not be installed
            this.logger.debug(`Could not get network interfaces for VM ${vmid}: ${error.message}`);
            return [];
        }
    }

    async getVMStatus(node, vmid) {
        try {
            const response = await this.axiosInstance.get(
                `https://${this.config.host}:${this.config.port}/api2/json/nodes/${node}/qemu/${vmid}/status/current`
            );
            return response.data.data || {};
        } catch (error) {
            this.logger.debug(`Could not get VM status for ${vmid}: ${error.message}`);
            return {};
        }
    }

    async getContainerStatus(node, vmid) {
        try {
            const response = await this.axiosInstance.get(
                `https://${this.config.host}:${this.config.port}/api2/json/nodes/${node}/lxc/${vmid}/status/current`
            );
            return response.data.data || {};
        } catch (error) {
            this.logger.debug(`Could not get container status for ${vmid}: ${error.message}`);
            return {};
        }
    }

    extractIPFromConfig(config) {
        // Try to extract IP from network configuration
        const netConfigs = Object.keys(config)
            .filter(key => key.startsWith('net'))
            .map(key => config[key]);

        for (const netConfig of netConfigs) {
            if (!netConfig) continue;
            
            // Parse various network config formats
            // Container format: "name=eth0,bridge=vmbr0,ip=192.168.1.100/24,..."
            // VM format: "virtio=XX:XX:XX:XX:XX:XX,bridge=vmbr0"
            // Some configs might have: "ip=dhcp" or "ip=192.168.1.100/24"
            
            const ipMatch = netConfig.match(/ip=([0-9.]+)/);
            if (ipMatch && ipMatch[1] !== 'dhcp') {
                return ipMatch[1];
            }
            
            // Also check for IPv4 in different format
            const ipv4Match = netConfig.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
            if (ipv4Match) {
                return ipv4Match[1];
            }
        }

        // Check ipconfig entries (for cloud-init)
        const ipconfigKeys = Object.keys(config).filter(key => key.startsWith('ipconfig'));
        for (const key of ipconfigKeys) {
            const ipconfig = config[key];
            if (!ipconfig) continue;
            
            // Format: "ip=192.168.1.100/24,gw=192.168.1.1"
            const ipMatch = ipconfig.match(/ip=([0-9.]+)/);
            if (ipMatch && ipMatch[1] !== 'dhcp') {
                return ipMatch[1];
            }
        }

        // Check description for IP hints (some setups store IP in description)
        if (config.description) {
            const ipMatch = config.description.match(/(?:ip|address)[:\s]*([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/i);
            if (ipMatch) {
                return ipMatch[1];
            }
        }

        // Check for notes field
        if (config.notes) {
            const ipMatch = config.notes.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
            if (ipMatch) {
                return ipMatch[1];
            }
        }

        return null;
    }

    formatHostname(name, type) {
        // Check if the name already contains a domain (has a dot)
        if (name.includes('.')) {
            // Use the name as-is since it's already a full domain
            return name.toLowerCase();
        }
        
        // Otherwise use the naming pattern
        let hostname = this.config.namingPattern
            .replace('{name}', name.toLowerCase())
            .replace('{type}', type.toLowerCase())
            .replace('{domain}', this.config.domain);
        
        // Clean up hostname
        hostname = hostname.replace(/[^a-z0-9.-]/g, '-');
        hostname = hostname.replace(/-+/g, '-');
        hostname = hostname.replace(/^-|-$/g, '');
        
        return hostname;
    }

    async syncProxmoxResources() {
        try {
            this.logger.info('Starting Proxmox resource sync...');
            
            // Re-authenticate if needed
            await this.authenticate();
            
            const nodes = await this.getNodes();
            const resources = [];
            
            for (const node of nodes) {
                // Get VMs
                const vms = await this.getVMs(node.node);
                this.logger.info(`Node ${node.node}: Found ${vms.length} VMs`);
                for (const vm of vms) {
                    // Include all VMs, not just running ones
                    const config = await this.getVMConfig(node.node, vm.vmid);
                    let interfaces = [];
                    
                    // Only try to get interfaces from running VMs with QEMU agent
                    if (vm.status === 'running') {
                        interfaces = await this.getVMInterfaces(node.node, vm.vmid);
                    }
                        
                        let ipAddress = null;
                        
                        // Try to get IP from agent
                        for (const iface of interfaces) {
                            if (iface['ip-addresses']) {
                                const ipv4 = iface['ip-addresses'].find(ip => ip['ip-address-type'] === 'ipv4');
                                if (ipv4 && !ipv4['ip-address'].startsWith('127.')) {
                                    ipAddress = ipv4['ip-address'];
                                    break;
                                }
                            }
                        }
                        
                        // Fallback to config
                        if (!ipAddress) {
                            ipAddress = this.extractIPFromConfig(config);
                        }
                        
                        if (ipAddress) {
                            // Extract port from description if specified
                            let port = 80;
                            if (config.description) {
                                const portMatch = config.description.match(/port[:\s]*(\d+)/i);
                                if (portMatch) {
                                    port = parseInt(portMatch[1]);
                                }
                            }
                            
                            // Common service port overrides
                            const servicePortMap = {
                                'pix': 2283,          // Immich photo manager
                                'immich': 2283,
                                'photostructure': 1787,
                                'jellyfin': 8096,
                                'plex': 32400,
                                'nextcloud': 443,
                                'onlyoffice': 8080,
                                'portainer': 9000,
                                'homeassistant': 8123,
                                'ha.': 8123,
                                'frigate': 5000,
                                'pihole': 80,
                                'adguard': 3000
                            };
                            
                            // Check if VM name contains a known service
                            const vmNameLower = vm.name.toLowerCase();
                            for (const [service, servicePort] of Object.entries(servicePortMap)) {
                                if (vmNameLower.includes(service)) {
                                    port = servicePort;
                                    break;
                                }
                            }
                            
                            resources.push({
                                type: 'vm',
                                vmid: vm.vmid,
                                name: vm.name,
                                node: node.node,
                                status: vm.status,
                                ip: ipAddress,
                                hostname: this.formatHostname(vm.name, 'vm'),
                                port: config.port || port,
                                description: config.description || `Proxmox VM ${vm.vmid}`,
                                active: vm.status === 'running'
                            });
                        } else {
                            this.logger.warn(`No IP found for VM ${vm.name} (${vm.vmid}) - Status: ${vm.status}`);
                        }
                }
                
                // Get Containers
                const containers = await this.getContainers(node.node);
                this.logger.info(`Node ${node.node}: Found ${containers.length} containers`);
                for (const ct of containers) {
                    // Include all containers, not just running ones
                    const config = await this.getContainerConfig(node.node, ct.vmid);
                    const ipAddress = this.extractIPFromConfig(config);
                    
                    if (ipAddress) {
                        // Extract port from description if specified
                        let port = 80;
                        if (config.description) {
                            const portMatch = config.description.match(/port[:\s]*(\d+)/i);
                            if (portMatch) {
                                port = parseInt(portMatch[1]);
                            }
                        }
                        
                        // Common service port overrides (same as VMs)
                        const servicePortMap = {
                            'pix': 2283,
                            'immich': 2283,
                            'photostructure': 1787,
                            'jellyfin': 8096,
                            'plex': 32400,
                            'nextcloud': 443,
                            'onlyoffice': 8080,
                            'portainer': 9000,
                            'homeassistant': 8123,
                            'ha.': 8123,
                            'frigate': 5000,
                            'pihole': 80,
                            'adguard': 3000,
                            'npm': 81,               // Nginx Proxy Manager
                            'traefik': 8080
                        };
                        
                        // Check if container name contains a known service
                        const ctNameLower = ct.name.toLowerCase();
                        for (const [service, servicePort] of Object.entries(servicePortMap)) {
                            if (ctNameLower.includes(service)) {
                                port = servicePort;
                                break;
                            }
                        }
                        
                        resources.push({
                            type: 'container',
                            vmid: ct.vmid,
                            name: ct.name,
                            node: node.node,
                            status: ct.status,
                            ip: ipAddress,
                            hostname: this.formatHostname(ct.name, 'ct'),
                            port: config.port || port,
                            description: config.description || `Proxmox Container ${ct.vmid}`,
                            active: ct.status === 'running'
                        });
                    } else {
                        this.logger.warn(`No IP found for Container ${ct.name} (${ct.vmid}) - Status: ${ct.status}`);
                    }
                }
            }
            
            this.logger.info(`Found ${resources.length} Proxmox resources`);
            
            // Update database with discovered resources
            await this.updateProxyEntries(resources);
            
            return resources;
        } catch (error) {
            this.logger.error(`Proxmox sync failed: ${error.message}`);
            throw error;
        }
    }

    async updateProxyEntries(resources) {
        try {
            for (const resource of resources) {
                // Extract the actual domain from the hostname
                const hostnameParts = resource.hostname.split('.');
                let domainName, subdomainName;
                
                if (hostnameParts.length >= 2) {
                    // Extract the domain (last two parts for most cases)
                    domainName = hostnameParts.slice(-2).join('.');
                    
                    // Handle special cases like .co.uk, .com.au etc
                    if (hostnameParts.length >= 3 && 
                        (hostnameParts[hostnameParts.length - 2] === 'co' || 
                         hostnameParts[hostnameParts.length - 2] === 'com' ||
                         hostnameParts[hostnameParts.length - 2] === 'org')) {
                        domainName = hostnameParts.slice(-3).join('.');
                    }
                    
                    // Get subdomain if exists
                    if (hostnameParts.length > 2) {
                        const domainParts = domainName.split('.');
                        subdomainName = hostnameParts.slice(0, -(domainParts.length)).join('.');
                    }
                } else {
                    // Fallback to config domain
                    domainName = this.config.domain;
                    subdomainName = resource.hostname;
                }
                
                // Check if domain exists
                let domain = await this.db.getDomain(domainName);
                
                if (!domain && this.config.autoCreateDomains) {
                    // Create domain if it doesn't exist
                    await this.db.createDomain(domainName, 'reverse');
                    domain = await this.db.getDomain(domainName);
                    this.logger.info(`Created domain ${domainName}`);
                }
                
                if (!domain) {
                    this.logger.warn(`Domain ${domainName} not found, skipping resource ${resource.name}`);
                    continue;
                }
                
                // Check if backend exists for this resource
                let backend = await this.db.get(
                    'SELECT * FROM backends WHERE name = ? AND active = 1',
                    [`proxmox-${resource.type}-${resource.vmid}`]
                );
                
                if (!backend) {
                    // Create backend
                    const result = await this.db.createBackend({
                        name: `proxmox-${resource.type}-${resource.vmid}`,
                        url: `http://${resource.ip}:${resource.port}`,
                        weight: 1,
                        healthCheckPath: '/'
                    });
                    backend = { id: result.id };
                    this.logger.info(`Created backend for ${resource.name} (${resource.ip}:${resource.port})`);
                }
                
                // Handle subdomain if exists
                if (subdomainName) {
                    let subdomain = await this.db.get(
                        'SELECT * FROM subdomains WHERE domainId = ? AND subdomain = ? AND active = 1',
                        [domain.id, subdomainName]
                    );
                    
                    if (!subdomain) {
                        // Create subdomain
                        const result = await this.db.createSubdomain(
                            domain.id,
                            subdomainName,
                            null,
                            false
                        );
                        subdomain = { id: result.id };
                        this.logger.info(`Created subdomain ${subdomainName}.${domainName}`);
                    }
                    
                    // Check if backend is assigned to subdomain
                    const assignment = await this.db.get(
                        'SELECT * FROM domain_backends WHERE domainId = ? AND backendId = ? AND subdomainId = ?',
                        [domain.id, backend.id, subdomain.id]
                    );
                    
                    if (!assignment) {
                        // Assign backend to subdomain
                        await this.db.assignBackendToDomain(
                            domain.id,
                            backend.id,
                            subdomain.id,
                            'round_robin'
                        );
                        this.logger.info(`Assigned backend to ${resource.hostname}`);
                    }
                } else {
                    // No subdomain, assign directly to domain
                    const assignment = await this.db.get(
                        'SELECT * FROM domain_backends WHERE domainId = ? AND backendId = ? AND subdomainId IS NULL',
                        [domain.id, backend.id]
                    );
                    
                    if (!assignment) {
                        // Assign backend to domain
                        await this.db.assignBackendToDomain(
                            domain.id,
                            backend.id,
                            null,
                            'round_robin'
                        );
                        this.logger.info(`Assigned backend to ${resource.hostname}`);
                    }
                }
                
                // Store Proxmox metadata
                await this.db.run(
                    `INSERT OR REPLACE INTO proxmox_resources 
                    (vmid, type, name, node, hostname, ip, port, backend_id, last_seen) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        resource.vmid,
                        resource.type,
                        resource.name,
                        resource.node,
                        resource.hostname,
                        resource.ip,
                        resource.port,
                        backend.id,
                        new Date().toISOString()
                    ]
                );
            }
            
            // Clean up old entries (not seen in last sync)
            const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes
            await this.db.run(
                'UPDATE backends SET active = 0 WHERE id IN (SELECT backend_id FROM proxmox_resources WHERE last_seen < ?)',
                [cutoff]
            );
            
        } catch (error) {
            this.logger.error(`Failed to update proxy entries: ${error.message}`);
            throw error;
        }
    }

    async startSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        
        // Initial sync
        await this.syncProxmoxResources();
        
        // Schedule periodic syncs
        this.syncInterval = setInterval(async () => {
            try {
                await this.syncProxmoxResources();
            } catch (error) {
                this.logger.error(`Proxmox sync error: ${error.message}`);
            }
        }, this.config.syncInterval);
        
        this.logger.info(`Proxmox sync scheduled every ${this.config.syncInterval / 1000} seconds`);
    }

    async stopSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
            this.logger.info('Proxmox sync stopped');
        }
    }

    async testConnection() {
        try {
            await this.authenticate();
            const nodes = await this.getNodes();
            return {
                success: true,
                nodes: nodes.length,
                message: `Successfully connected to Proxmox cluster with ${nodes.length} node(s)`
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    async manualSync() {
        try {
            const resources = await this.syncProxmoxResources();
            return {
                success: true,
                count: resources.length,
                resources
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = ProxmoxIntegration;