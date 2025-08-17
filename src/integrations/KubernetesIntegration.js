const k8s = require('@kubernetes/client-node');
const Logger = require('../utils/Logger');
const EventEmitter = require('events');

class KubernetesIntegration extends EventEmitter {
    constructor(options = {}) {
        super();
        this.logger = new Logger();
        this.db = options.database;
        
        // Kubernetes configuration
        this.kc = new k8s.KubeConfig();
        this.namespace = options.namespace || 'default';
        this.labelSelector = options.labelSelector || 'proxy=rawrproxy';
        this.annotationPrefix = options.annotationPrefix || 'rawrproxy.io/';
        
        // Service discovery
        this.services = new Map();
        this.endpoints = new Map();
        this.ingresses = new Map();
        this.configMaps = new Map();
        this.secrets = new Map();
        
        // Watchers
        this.watchers = [];
        this.syncInterval = options.syncInterval || 30000; // 30 seconds
        
        // Ingress controller mode
        this.ingressMode = options.ingressMode || false;
        this.ingressClass = options.ingressClass || 'rawrproxy';
        
        this.logger.info('Kubernetes integration initialized');
    }

    // Initialize Kubernetes client
    async initialize() {
        try {
            // Try to load in-cluster config first
            try {
                this.kc.loadFromCluster();
                this.logger.info('Loaded in-cluster Kubernetes config');
            } catch (error) {
                // Fall back to kubeconfig file
                this.kc.loadFromDefault();
                this.logger.info('Loaded Kubernetes config from kubeconfig');
            }
            
            // Create API clients
            this.coreV1Api = this.kc.makeApiClient(k8s.CoreV1Api);
            this.appsV1Api = this.kc.makeApiClient(k8s.AppsV1Api);
            this.networkingV1Api = this.kc.makeApiClient(k8s.NetworkingV1Api);
            
            // Start watching resources
            await this.startWatching();
            
            // Initial sync
            await this.syncResources();
            
            this.logger.info('Kubernetes integration initialized successfully');
            return true;
        } catch (error) {
            this.logger.error(`Failed to initialize Kubernetes integration: ${error.message}`);
            return false;
        }
    }

    // Start watching Kubernetes resources
    async startWatching() {
        // Watch Services
        await this.watchResource('/api/v1/services', (type, service) => {
            this.handleServiceChange(type, service);
        });
        
        // Watch Endpoints
        await this.watchResource('/api/v1/endpoints', (type, endpoints) => {
            this.handleEndpointsChange(type, endpoints);
        });
        
        // Watch Ingresses
        await this.watchResource('/apis/networking.k8s.io/v1/ingresses', (type, ingress) => {
            this.handleIngressChange(type, ingress);
        });
        
        // Watch ConfigMaps
        await this.watchResource('/api/v1/configmaps', (type, configMap) => {
            this.handleConfigMapChange(type, configMap);
        });
        
        // Watch Secrets (for TLS certificates)
        await this.watchResource('/api/v1/secrets', (type, secret) => {
            this.handleSecretChange(type, secret);
        });
        
        this.logger.info('Started watching Kubernetes resources');
    }

    // Generic resource watcher
    async watchResource(path, handler) {
        const watch = new k8s.Watch(this.kc);
        
        const watcher = await watch.watch(
            path,
            {
                labelSelector: this.labelSelector,
                watch: true
            },
            handler,
            (error) => {
                this.logger.error(`Watch error for ${path}: ${error.message}`);
                // Reconnect after error
                setTimeout(() => this.watchResource(path, handler), 5000);
            }
        );
        
        this.watchers.push(watcher);
        return watcher;
    }

    // Handle Service changes
    handleServiceChange(type, service) {
        const name = service.metadata.name;
        const namespace = service.metadata.namespace;
        const key = `${namespace}/${name}`;
        
        switch (type) {
            case 'ADDED':
            case 'MODIFIED':
                this.services.set(key, this.parseService(service));
                this.logger.info(`Service ${type.toLowerCase()}: ${key}`);
                this.emit('serviceChanged', { type, service: this.services.get(key) });
                break;
            case 'DELETED':
                this.services.delete(key);
                this.logger.info(`Service deleted: ${key}`);
                this.emit('serviceDeleted', { key });
                break;
        }
        
        // Update backends in database
        this.updateBackendsFromServices();
    }

    // Handle Endpoints changes
    handleEndpointsChange(type, endpoints) {
        const name = endpoints.metadata.name;
        const namespace = endpoints.metadata.namespace;
        const key = `${namespace}/${name}`;
        
        switch (type) {
            case 'ADDED':
            case 'MODIFIED':
                this.endpoints.set(key, this.parseEndpoints(endpoints));
                this.logger.info(`Endpoints ${type.toLowerCase()}: ${key}`);
                this.emit('endpointsChanged', { type, endpoints: this.endpoints.get(key) });
                break;
            case 'DELETED':
                this.endpoints.delete(key);
                this.logger.info(`Endpoints deleted: ${key}`);
                this.emit('endpointsDeleted', { key });
                break;
        }
        
        // Update backend health status
        this.updateBackendHealth();
    }

    // Handle Ingress changes
    handleIngressChange(type, ingress) {
        const name = ingress.metadata.name;
        const namespace = ingress.metadata.namespace;
        const key = `${namespace}/${name}`;
        
        // Check if this ingress is for our controller
        if (this.ingressMode) {
            const ingressClass = ingress.spec?.ingressClassName || 
                               ingress.metadata?.annotations?.['kubernetes.io/ingress.class'];
            
            if (ingressClass !== this.ingressClass) {
                return; // Not for us
            }
        }
        
        switch (type) {
            case 'ADDED':
            case 'MODIFIED':
                this.ingresses.set(key, this.parseIngress(ingress));
                this.logger.info(`Ingress ${type.toLowerCase()}: ${key}`);
                this.emit('ingressChanged', { type, ingress: this.ingresses.get(key) });
                
                // Update routing rules
                this.updateRoutingFromIngress(this.ingresses.get(key));
                break;
            case 'DELETED':
                this.ingresses.delete(key);
                this.logger.info(`Ingress deleted: ${key}`);
                this.emit('ingressDeleted', { key });
                
                // Remove routing rules
                this.removeRoutingForIngress(key);
                break;
        }
    }

    // Handle ConfigMap changes
    handleConfigMapChange(type, configMap) {
        const name = configMap.metadata.name;
        const namespace = configMap.metadata.namespace;
        const key = `${namespace}/${name}`;
        
        // Check if this ConfigMap is relevant (has our annotations)
        const annotations = configMap.metadata.annotations || {};
        const isRelevant = Object.keys(annotations).some(k => k.startsWith(this.annotationPrefix));
        
        if (!isRelevant) return;
        
        switch (type) {
            case 'ADDED':
            case 'MODIFIED':
                this.configMaps.set(key, configMap);
                this.logger.info(`ConfigMap ${type.toLowerCase()}: ${key}`);
                this.emit('configMapChanged', { type, configMap });
                
                // Apply configuration changes
                this.applyConfigMapChanges(configMap);
                break;
            case 'DELETED':
                this.configMaps.delete(key);
                this.logger.info(`ConfigMap deleted: ${key}`);
                this.emit('configMapDeleted', { key });
                break;
        }
    }

    // Handle Secret changes
    handleSecretChange(type, secret) {
        const name = secret.metadata.name;
        const namespace = secret.metadata.namespace;
        const key = `${namespace}/${name}`;
        
        // Only handle TLS secrets
        if (secret.type !== 'kubernetes.io/tls') return;
        
        switch (type) {
            case 'ADDED':
            case 'MODIFIED':
                this.secrets.set(key, {
                    name: name,
                    namespace: namespace,
                    cert: Buffer.from(secret.data['tls.crt'], 'base64').toString(),
                    key: Buffer.from(secret.data['tls.key'], 'base64').toString()
                });
                this.logger.info(`TLS Secret ${type.toLowerCase()}: ${key}`);
                this.emit('tlsSecretChanged', { type, secret: this.secrets.get(key) });
                break;
            case 'DELETED':
                this.secrets.delete(key);
                this.logger.info(`TLS Secret deleted: ${key}`);
                this.emit('tlsSecretDeleted', { key });
                break;
        }
    }

    // Parse Service object
    parseService(service) {
        const annotations = service.metadata.annotations || {};
        
        return {
            name: service.metadata.name,
            namespace: service.metadata.namespace,
            labels: service.metadata.labels || {},
            annotations: annotations,
            
            // Service details
            type: service.spec.type,
            clusterIP: service.spec.clusterIP,
            ports: service.spec.ports?.map(port => ({
                name: port.name,
                protocol: port.protocol,
                port: port.port,
                targetPort: port.targetPort,
                nodePort: port.nodePort
            })) || [],
            
            // RAWRProxy specific annotations
            proxyConfig: {
                enabled: annotations[`${this.annotationPrefix}enabled`] === 'true',
                loadBalance: annotations[`${this.annotationPrefix}load-balance`] || 'round_robin',
                healthCheck: annotations[`${this.annotationPrefix}health-check`] || '/health',
                timeout: parseInt(annotations[`${this.annotationPrefix}timeout`]) || 30000,
                retries: parseInt(annotations[`${this.annotationPrefix}retries`]) || 3,
                circuitBreaker: annotations[`${this.annotationPrefix}circuit-breaker`] === 'true',
                rateLimit: parseInt(annotations[`${this.annotationPrefix}rate-limit`]) || 0,
                authentication: annotations[`${this.annotationPrefix}auth`] || 'none',
                cors: annotations[`${this.annotationPrefix}cors`] === 'true',
                compression: annotations[`${this.annotationPrefix}compression`] === 'true',
                caching: annotations[`${this.annotationPrefix}caching`] === 'true',
                websocket: annotations[`${this.annotationPrefix}websocket`] === 'true',
                grpc: annotations[`${this.annotationPrefix}grpc`] === 'true'
            }
        };
    }

    // Parse Endpoints object
    parseEndpoints(endpoints) {
        const addresses = [];
        
        for (const subset of (endpoints.subsets || [])) {
            for (const address of (subset.addresses || [])) {
                for (const port of (subset.ports || [])) {
                    addresses.push({
                        ip: address.ip,
                        port: port.port,
                        protocol: port.protocol,
                        portName: port.name,
                        nodeName: address.nodeName,
                        targetRef: address.targetRef
                    });
                }
            }
        }
        
        return {
            name: endpoints.metadata.name,
            namespace: endpoints.metadata.namespace,
            addresses: addresses
        };
    }

    // Parse Ingress object
    parseIngress(ingress) {
        const rules = [];
        
        for (const rule of (ingress.spec.rules || [])) {
            const host = rule.host;
            
            for (const path of (rule.http?.paths || [])) {
                rules.push({
                    host: host,
                    path: path.path,
                    pathType: path.pathType,
                    backend: {
                        service: path.backend?.service?.name,
                        port: path.backend?.service?.port?.number || path.backend?.service?.port?.name
                    }
                });
            }
        }
        
        return {
            name: ingress.metadata.name,
            namespace: ingress.metadata.namespace,
            annotations: ingress.metadata.annotations || {},
            rules: rules,
            tls: ingress.spec.tls?.map(tls => ({
                hosts: tls.hosts,
                secretName: tls.secretName
            })) || []
        };
    }

    // Update backends from Services
    async updateBackendsFromServices() {
        if (!this.db) return;
        
        for (const [key, service] of this.services) {
            if (!service.proxyConfig.enabled) continue;
            
            const endpoints = this.endpoints.get(key);
            if (!endpoints || endpoints.addresses.length === 0) continue;
            
            // Create backend entries for each endpoint
            for (const endpoint of endpoints.addresses) {
                const url = `http://${endpoint.ip}:${endpoint.port}`;
                const name = `k8s-${service.namespace}-${service.name}-${endpoint.ip}`;
                
                try {
                    // Check if backend exists
                    const existing = await this.db.get(
                        'SELECT id FROM backends WHERE name = ?',
                        [name]
                    );
                    
                    if (existing) {
                        // Update existing backend
                        await this.db.run(
                            `UPDATE backends SET 
                             url = ?, active = 1, 
                             load_balance_method = ?,
                             health_check_endpoint = ?,
                             timeout = ?, max_retries = ?,
                             circuit_breaker_enabled = ?,
                             ws_supported = ?, grpc_supported = ?,
                             updated_at = CURRENT_TIMESTAMP
                             WHERE id = ?`,
                            [url, service.proxyConfig.loadBalance,
                             service.proxyConfig.healthCheck,
                             service.proxyConfig.timeout,
                             service.proxyConfig.retries,
                             service.proxyConfig.circuitBreaker ? 1 : 0,
                             service.proxyConfig.websocket ? 1 : 0,
                             service.proxyConfig.grpc ? 1 : 0,
                             existing.id]
                        );
                    } else {
                        // Create new backend
                        await this.db.run(
                            `INSERT INTO backends 
                             (name, url, active, load_balance_method,
                              health_check_endpoint, timeout, max_retries,
                              circuit_breaker_enabled, ws_supported, grpc_supported)
                             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
                            [name, url,
                             service.proxyConfig.loadBalance,
                             service.proxyConfig.healthCheck,
                             service.proxyConfig.timeout,
                             service.proxyConfig.retries,
                             service.proxyConfig.circuitBreaker ? 1 : 0,
                             service.proxyConfig.websocket ? 1 : 0,
                             service.proxyConfig.grpc ? 1 : 0]
                        );
                    }
                    
                    this.logger.info(`Updated backend from K8s service: ${name}`);
                } catch (error) {
                    this.logger.error(`Failed to update backend ${name}: ${error.message}`);
                }
            }
        }
    }

    // Update backend health status
    async updateBackendHealth() {
        if (!this.db) return;
        
        for (const [key, endpoints] of this.endpoints) {
            const service = this.services.get(key);
            if (!service || !service.proxyConfig.enabled) continue;
            
            // Mark backends as healthy/unhealthy based on endpoints
            for (const endpoint of endpoints.addresses) {
                const name = `k8s-${endpoints.namespace}-${endpoints.name}-${endpoint.ip}`;
                
                try {
                    await this.db.run(
                        'UPDATE backends SET health_status = ? WHERE name = ?',
                        ['healthy', name]
                    );
                } catch (error) {
                    this.logger.error(`Failed to update health for ${name}: ${error.message}`);
                }
            }
        }
    }

    // Update routing from Ingress
    async updateRoutingFromIngress(ingress) {
        if (!this.db) return;
        
        for (const rule of ingress.rules) {
            try {
                // Find or create domain
                let domain = await this.db.get(
                    'SELECT id FROM domains WHERE domain = ?',
                    [rule.host]
                );
                
                if (!domain) {
                    const result = await this.db.run(
                        'INSERT INTO domains (domain, active) VALUES (?, 1)',
                        [rule.host]
                    );
                    domain = { id: result.lastID };
                }
                
                // Find backend service
                const serviceKey = `${ingress.namespace}/${rule.backend.service}`;
                const service = this.services.get(serviceKey);
                
                if (service && service.proxyConfig.enabled) {
                    // Link domain to backends
                    const backends = await this.db.all(
                        'SELECT id FROM backends WHERE name LIKE ?',
                        [`k8s-${ingress.namespace}-${rule.backend.service}-%`]
                    );
                    
                    for (const backend of backends) {
                        // Check if link exists
                        const existing = await this.db.get(
                            'SELECT id FROM domain_backends WHERE domainId = ? AND backendId = ?',
                            [domain.id, backend.id]
                        );
                        
                        if (!existing) {
                            await this.db.run(
                                'INSERT INTO domain_backends (domainId, backendId) VALUES (?, ?)',
                                [domain.id, backend.id]
                            );
                        }
                    }
                    
                    this.logger.info(`Updated routing for ${rule.host} from Ingress`);
                }
            } catch (error) {
                this.logger.error(`Failed to update routing from Ingress: ${error.message}`);
            }
        }
    }

    // Remove routing for deleted Ingress
    async removeRoutingForIngress(ingressKey) {
        // Implementation would remove domain/backend mappings
        this.logger.info(`Removing routing for deleted Ingress: ${ingressKey}`);
    }

    // Apply ConfigMap changes
    async applyConfigMapChanges(configMap) {
        const data = configMap.data || {};
        
        // Apply proxy configuration from ConfigMap
        for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('proxy.')) {
                const configKey = key.substring(6);
                this.logger.info(`Applying config: ${configKey} = ${value}`);
                
                // Update configuration in memory or database
                this.emit('configUpdate', { key: configKey, value });
            }
        }
    }

    // Sync all resources
    async syncResources() {
        try {
            // List all services
            const services = await this.coreV1Api.listServiceForAllNamespaces(
                undefined, undefined, undefined, undefined,
                this.labelSelector
            );
            
            for (const service of services.body.items) {
                this.handleServiceChange('ADDED', service);
            }
            
            // List all endpoints
            const endpoints = await this.coreV1Api.listEndpointsForAllNamespaces(
                undefined, undefined, undefined, undefined,
                this.labelSelector
            );
            
            for (const endpoint of endpoints.body.items) {
                this.handleEndpointsChange('ADDED', endpoint);
            }
            
            // List all ingresses
            const ingresses = await this.networkingV1Api.listIngressForAllNamespaces(
                undefined, undefined, undefined, undefined,
                this.labelSelector
            );
            
            for (const ingress of ingresses.body.items) {
                this.handleIngressChange('ADDED', ingress);
            }
            
            this.logger.info('Completed initial resource sync');
        } catch (error) {
            this.logger.error(`Failed to sync resources: ${error.message}`);
        }
    }

    // Create an Ingress resource
    async createIngress(config) {
        const ingress = {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'Ingress',
            metadata: {
                name: config.name,
                namespace: config.namespace || this.namespace,
                annotations: {
                    'kubernetes.io/ingress.class': this.ingressClass,
                    ...config.annotations
                }
            },
            spec: {
                ingressClassName: this.ingressClass,
                rules: config.rules.map(rule => ({
                    host: rule.host,
                    http: {
                        paths: rule.paths.map(path => ({
                            path: path.path,
                            pathType: path.pathType || 'Prefix',
                            backend: {
                                service: {
                                    name: path.serviceName,
                                    port: {
                                        number: path.servicePort
                                    }
                                }
                            }
                        }))
                    }
                })),
                tls: config.tls || []
            }
        };
        
        try {
            const result = await this.networkingV1Api.createNamespacedIngress(
                config.namespace || this.namespace,
                ingress
            );
            
            this.logger.info(`Created Ingress: ${config.name}`);
            return result.body;
        } catch (error) {
            this.logger.error(`Failed to create Ingress: ${error.message}`);
            throw error;
        }
    }

    // Get service discovery information
    getServiceDiscovery() {
        const discovery = {
            services: [],
            endpoints: []
        };
        
        for (const [key, service] of this.services) {
            if (service.proxyConfig.enabled) {
                const endpoints = this.endpoints.get(key);
                
                discovery.services.push({
                    name: service.name,
                    namespace: service.namespace,
                    config: service.proxyConfig,
                    endpoints: endpoints?.addresses || []
                });
            }
        }
        
        return discovery;
    }

    // Get statistics
    getStats() {
        return {
            services: this.services.size,
            endpoints: this.endpoints.size,
            ingresses: this.ingresses.size,
            configMaps: this.configMaps.size,
            secrets: this.secrets.size,
            watchers: this.watchers.length
        };
    }

    // Cleanup
    async shutdown() {
        // Stop all watchers
        for (const watcher of this.watchers) {
            if (watcher && typeof watcher.abort === 'function') {
                watcher.abort();
            }
        }
        
        this.watchers = [];
        this.logger.info('Kubernetes integration shut down');
    }
}

module.exports = KubernetesIntegration;