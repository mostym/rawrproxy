const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { X509Certificate } = require('crypto');
const Logger = require('../utils/Logger');

class AdvancedSecurity {
    constructor(options = {}) {
        this.logger = new Logger();
        this.db = options.database;
        this.redisCache = options.redisCache;
        
        // mTLS Configuration
        this.mtls = {
            enabled: options.mtls?.enabled || false,
            ca: options.mtls?.ca || null,
            clientCerts: new Map(),
            verify: options.mtls?.verify || 'required', // required, optional, none
            depth: options.mtls?.depth || 5
        };
        
        // API Key Management
        this.apiKeys = {
            enabled: options.apiKeys?.enabled || true,
            storage: new Map(),
            rateLimit: options.apiKeys?.rateLimit || {},
            rotation: options.apiKeys?.rotation || { enabled: true, period: 90 }
        };
        
        // IP Whitelisting/Blacklisting
        this.ipFilter = {
            enabled: options.ipFilter?.enabled || true,
            whitelist: new Set(options.ipFilter?.whitelist || []),
            blacklist: new Set(options.ipFilter?.blacklist || []),
            mode: options.ipFilter?.mode || 'blacklist', // whitelist, blacklist, both
            geoBlocking: options.ipFilter?.geoBlocking || { enabled: false, countries: [] }
        };
        
        // Security Headers
        this.headers = {
            enabled: options.headers?.enabled !== false,
            hsts: options.headers?.hsts || { maxAge: 31536000, includeSubDomains: true },
            csp: options.headers?.csp || "default-src 'self'",
            frameOptions: options.headers?.frameOptions || 'DENY',
            contentTypeOptions: options.headers?.contentTypeOptions || 'nosniff',
            xssProtection: options.headers?.xssProtection || '1; mode=block'
        };
        
        // Encryption
        this.encryption = {
            algorithm: options.encryption?.algorithm || 'aes-256-gcm',
            key: options.encryption?.key || crypto.randomBytes(32),
            saltLength: options.encryption?.saltLength || 16
        };
        
        // Request Signing
        this.signing = {
            enabled: options.signing?.enabled || false,
            algorithm: options.signing?.algorithm || 'sha256',
            secret: options.signing?.secret || crypto.randomBytes(32).toString('hex'),
            maxAge: options.signing?.maxAge || 300000 // 5 minutes
        };
        
        // Statistics
        this.stats = {
            mtlsConnections: 0,
            mtlsRejections: 0,
            apiKeyVerifications: 0,
            apiKeyRejections: 0,
            ipAllowed: 0,
            ipBlocked: 0,
            encryptedData: 0,
            signatureVerifications: 0
        };
        
        this.logger.info('Advanced security initialized');
    }

    // Initialize security features
    async initialize() {
        // Load mTLS certificates
        if (this.mtls.enabled) {
            await this.loadMTLSCertificates();
        }
        
        // Load API keys from database
        if (this.apiKeys.enabled && this.db) {
            await this.loadAPIKeys();
        }
        
        // Load IP rules from database
        if (this.ipFilter.enabled && this.db) {
            await this.loadIPRules();
        }
        
        // Start API key rotation timer
        if (this.apiKeys.rotation.enabled) {
            this.startAPIKeyRotation();
        }
        
        this.logger.info('Security features initialized');
    }

    // mTLS: Load certificates
    async loadMTLSCertificates() {
        try {
            // Load CA certificate
            if (this.mtls.ca) {
                this.mtls.caCert = fs.readFileSync(this.mtls.ca);
                this.logger.info('Loaded CA certificate for mTLS');
            }
            
            // Load trusted client certificates from database
            if (this.db) {
                const certs = await this.db.all(
                    'SELECT * FROM client_certificates WHERE active = 1'
                );
                
                for (const cert of certs) {
                    this.mtls.clientCerts.set(cert.fingerprint, {
                        id: cert.id,
                        subject: cert.subject,
                        issuer: cert.issuer,
                        notBefore: cert.not_before,
                        notAfter: cert.not_after,
                        permissions: JSON.parse(cert.permissions || '[]')
                    });
                }
                
                this.logger.info(`Loaded ${certs.length} client certificates`);
            }
        } catch (error) {
            this.logger.error(`Failed to load mTLS certificates: ${error.message}`);
        }
    }

    // mTLS: Verify client certificate
    verifyClientCertificate(socket) {
        if (!this.mtls.enabled) return { valid: true };
        
        this.stats.mtlsConnections++;
        
        const cert = socket.getPeerCertificate();
        
        if (!cert || Object.keys(cert).length === 0) {
            if (this.mtls.verify === 'required') {
                this.stats.mtlsRejections++;
                return { valid: false, error: 'No client certificate provided' };
            }
            return { valid: true, anonymous: true };
        }
        
        // Check if certificate is authorized
        const authorized = socket.authorized;
        if (!authorized) {
            this.stats.mtlsRejections++;
            return { valid: false, error: socket.authorizationError };
        }
        
        // Calculate fingerprint
        const fingerprint = cert.fingerprint256;
        
        // Check if certificate is in our trust store
        const trustedCert = this.mtls.clientCerts.get(fingerprint);
        if (!trustedCert) {
            if (this.mtls.verify === 'required') {
                this.stats.mtlsRejections++;
                return { valid: false, error: 'Certificate not in trust store' };
            }
            return { valid: true, untrusted: true };
        }
        
        // Check certificate validity
        const now = new Date();
        if (now < new Date(trustedCert.notBefore) || now > new Date(trustedCert.notAfter)) {
            this.stats.mtlsRejections++;
            return { valid: false, error: 'Certificate expired or not yet valid' };
        }
        
        return {
            valid: true,
            certificate: trustedCert,
            fingerprint: fingerprint,
            subject: cert.subject,
            issuer: cert.issuer
        };
    }

    // API Keys: Generate new API key
    generateAPIKey(metadata = {}) {
        const key = crypto.randomBytes(32).toString('hex');
        const hashedKey = crypto.createHash('sha256').update(key).digest('hex');
        
        const apiKey = {
            id: crypto.randomBytes(16).toString('hex'),
            key: hashedKey,
            plainKey: key, // Only returned once
            name: metadata.name || 'API Key',
            description: metadata.description || '',
            permissions: metadata.permissions || [],
            rateLimit: metadata.rateLimit || this.apiKeys.rateLimit,
            createdAt: new Date(),
            expiresAt: metadata.expiresAt || null,
            lastUsed: null,
            usageCount: 0,
            active: true
        };
        
        this.apiKeys.storage.set(hashedKey, apiKey);
        
        // Store in database
        if (this.db) {
            this.db.run(
                `INSERT INTO api_keys 
                 (id, key_hash, name, description, permissions, rate_limit, expires_at, active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                [apiKey.id, hashedKey, apiKey.name, apiKey.description,
                 JSON.stringify(apiKey.permissions), JSON.stringify(apiKey.rateLimit),
                 apiKey.expiresAt]
            ).catch(err => this.logger.error(`Failed to store API key: ${err.message}`));
        }
        
        this.logger.info(`Generated new API key: ${apiKey.name}`);
        return apiKey;
    }

    // API Keys: Verify API key
    async verifyAPIKey(key) {
        if (!this.apiKeys.enabled) return { valid: true };
        
        this.stats.apiKeyVerifications++;
        
        if (!key) {
            this.stats.apiKeyRejections++;
            return { valid: false, error: 'No API key provided' };
        }
        
        // Hash the provided key
        const hashedKey = crypto.createHash('sha256').update(key).digest('hex');
        
        // Check cache first
        let apiKey = this.apiKeys.storage.get(hashedKey);
        
        // Check database if not in cache
        if (!apiKey && this.db) {
            const dbKey = await this.db.get(
                'SELECT * FROM api_keys WHERE key_hash = ? AND active = 1',
                [hashedKey]
            );
            
            if (dbKey) {
                apiKey = {
                    ...dbKey,
                    permissions: JSON.parse(dbKey.permissions || '[]'),
                    rateLimit: JSON.parse(dbKey.rate_limit || '{}')
                };
                this.apiKeys.storage.set(hashedKey, apiKey);
            }
        }
        
        if (!apiKey || !apiKey.active) {
            this.stats.apiKeyRejections++;
            return { valid: false, error: 'Invalid API key' };
        }
        
        // Check expiration
        if (apiKey.expiresAt && new Date() > new Date(apiKey.expiresAt)) {
            this.stats.apiKeyRejections++;
            return { valid: false, error: 'API key expired' };
        }
        
        // Update usage statistics
        apiKey.lastUsed = new Date();
        apiKey.usageCount++;
        
        // Update in database
        if (this.db) {
            this.db.run(
                'UPDATE api_keys SET last_used = CURRENT_TIMESTAMP, usage_count = usage_count + 1 WHERE id = ?',
                [apiKey.id]
            ).catch(err => this.logger.error(`Failed to update API key usage: ${err.message}`));
        }
        
        return {
            valid: true,
            apiKey: {
                id: apiKey.id,
                name: apiKey.name,
                permissions: apiKey.permissions,
                rateLimit: apiKey.rateLimit
            }
        };
    }

    // API Keys: Rotate keys
    async rotateAPIKey(keyId) {
        const oldKey = Array.from(this.apiKeys.storage.values()).find(k => k.id === keyId);
        if (!oldKey) {
            throw new Error('API key not found');
        }
        
        // Generate new key with same metadata
        const newKey = this.generateAPIKey({
            name: oldKey.name + ' (Rotated)',
            description: oldKey.description,
            permissions: oldKey.permissions,
            rateLimit: oldKey.rateLimit
        });
        
        // Deactivate old key
        oldKey.active = false;
        if (this.db) {
            await this.db.run('UPDATE api_keys SET active = 0 WHERE id = ?', [oldKey.id]);
        }
        
        this.logger.info(`Rotated API key: ${oldKey.name}`);
        return newKey;
    }

    // API Keys: Load from database
    async loadAPIKeys() {
        if (!this.db) return;
        
        try {
            const keys = await this.db.all('SELECT * FROM api_keys WHERE active = 1');
            
            for (const key of keys) {
                this.apiKeys.storage.set(key.key_hash, {
                    ...key,
                    permissions: JSON.parse(key.permissions || '[]'),
                    rateLimit: JSON.parse(key.rate_limit || '{}')
                });
            }
            
            this.logger.info(`Loaded ${keys.length} API keys`);
        } catch (error) {
            this.logger.error(`Failed to load API keys: ${error.message}`);
        }
    }

    // API Keys: Start rotation timer
    startAPIKeyRotation() {
        const periodMs = this.apiKeys.rotation.period * 24 * 60 * 60 * 1000; // Convert days to ms
        
        setInterval(async () => {
            const now = new Date();
            
            for (const [hash, key] of this.apiKeys.storage) {
                const age = now - new Date(key.createdAt);
                
                if (age > periodMs) {
                    try {
                        await this.rotateAPIKey(key.id);
                    } catch (error) {
                        this.logger.error(`Failed to auto-rotate key ${key.id}: ${error.message}`);
                    }
                }
            }
        }, 24 * 60 * 60 * 1000); // Check daily
    }

    // IP Filter: Check IP address
    checkIPAddress(ip) {
        if (!this.ipFilter.enabled) return { allowed: true };
        
        // Normalize IP address
        const normalizedIP = this.normalizeIP(ip);
        
        // Check blacklist first
        if (this.ipFilter.blacklist.has(normalizedIP)) {
            this.stats.ipBlocked++;
            return { allowed: false, reason: 'IP blacklisted' };
        }
        
        // Check whitelist if in whitelist mode
        if (this.ipFilter.mode === 'whitelist' || this.ipFilter.mode === 'both') {
            if (!this.ipFilter.whitelist.has(normalizedIP)) {
                // Check for CIDR ranges
                let inWhitelist = false;
                for (const range of this.ipFilter.whitelist) {
                    if (this.ipInRange(normalizedIP, range)) {
                        inWhitelist = true;
                        break;
                    }
                }
                
                if (!inWhitelist) {
                    this.stats.ipBlocked++;
                    return { allowed: false, reason: 'IP not whitelisted' };
                }
            }
        }
        
        // Check geo-blocking
        if (this.ipFilter.geoBlocking.enabled) {
            const country = this.getIPCountry(normalizedIP);
            if (this.ipFilter.geoBlocking.countries.includes(country)) {
                this.stats.ipBlocked++;
                return { allowed: false, reason: `Country blocked: ${country}` };
            }
        }
        
        this.stats.ipAllowed++;
        return { allowed: true };
    }

    // IP Filter: Add to whitelist
    addToWhitelist(ip) {
        const normalizedIP = this.normalizeIP(ip);
        this.ipFilter.whitelist.add(normalizedIP);
        
        if (this.db) {
            this.db.run(
                'INSERT OR IGNORE INTO ip_whitelist (ip, added_at) VALUES (?, CURRENT_TIMESTAMP)',
                [normalizedIP]
            ).catch(err => this.logger.error(`Failed to add IP to whitelist: ${err.message}`));
        }
        
        this.logger.info(`Added ${normalizedIP} to whitelist`);
    }

    // IP Filter: Add to blacklist
    addToBlacklist(ip, reason = '') {
        const normalizedIP = this.normalizeIP(ip);
        this.ipFilter.blacklist.add(normalizedIP);
        
        if (this.db) {
            this.db.run(
                'INSERT OR IGNORE INTO ip_blacklist (ip, reason, added_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                [normalizedIP, reason]
            ).catch(err => this.logger.error(`Failed to add IP to blacklist: ${err.message}`));
        }
        
        this.logger.info(`Added ${normalizedIP} to blacklist: ${reason}`);
    }

    // IP Filter: Load rules from database
    async loadIPRules() {
        if (!this.db) return;
        
        try {
            // Load whitelist
            const whitelist = await this.db.all('SELECT ip FROM ip_whitelist WHERE active = 1');
            for (const entry of whitelist) {
                this.ipFilter.whitelist.add(entry.ip);
            }
            
            // Load blacklist
            const blacklist = await this.db.all('SELECT ip FROM ip_blacklist WHERE active = 1');
            for (const entry of blacklist) {
                this.ipFilter.blacklist.add(entry.ip);
            }
            
            this.logger.info(`Loaded ${whitelist.length} whitelist and ${blacklist.length} blacklist entries`);
        } catch (error) {
            this.logger.error(`Failed to load IP rules: ${error.message}`);
        }
    }

    // Utility: Normalize IP address
    normalizeIP(ip) {
        // Remove IPv6 prefix if present
        if (ip.startsWith('::ffff:')) {
            return ip.substring(7);
        }
        return ip;
    }

    // Utility: Check if IP is in range
    ipInRange(ip, range) {
        // Simple implementation - would need proper CIDR support
        if (range.includes('/')) {
            const [subnet, bits] = range.split('/');
            const mask = parseInt(bits);
            // Simplified check - proper implementation would convert to binary
            return ip.startsWith(subnet.split('.').slice(0, Math.floor(mask / 8)).join('.'));
        }
        return ip === range;
    }

    // Utility: Get country from IP (mock implementation)
    getIPCountry(ip) {
        // Real implementation would use GeoIP database
        return 'US';
    }

    // Security Headers: Apply security headers
    applySecurityHeaders(res) {
        if (!this.headers.enabled) return;
        
        // HSTS
        if (this.headers.hsts) {
            let hstsValue = `max-age=${this.headers.hsts.maxAge}`;
            if (this.headers.hsts.includeSubDomains) {
                hstsValue += '; includeSubDomains';
            }
            if (this.headers.hsts.preload) {
                hstsValue += '; preload';
            }
            res.setHeader('Strict-Transport-Security', hstsValue);
        }
        
        // Content Security Policy
        if (this.headers.csp) {
            res.setHeader('Content-Security-Policy', this.headers.csp);
        }
        
        // Frame Options
        if (this.headers.frameOptions) {
            res.setHeader('X-Frame-Options', this.headers.frameOptions);
        }
        
        // Content Type Options
        if (this.headers.contentTypeOptions) {
            res.setHeader('X-Content-Type-Options', this.headers.contentTypeOptions);
        }
        
        // XSS Protection
        if (this.headers.xssProtection) {
            res.setHeader('X-XSS-Protection', this.headers.xssProtection);
        }
        
        // Additional security headers
        res.setHeader('X-Powered-By', 'RAWRProxy');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    }

    // Encryption: Encrypt data
    encrypt(data) {
        this.stats.encryptedData++;
        
        const iv = crypto.randomBytes(16);
        const salt = crypto.randomBytes(this.encryption.saltLength);
        
        // Derive key from salt
        const key = crypto.pbkdf2Sync(this.encryption.key, salt, 100000, 32, 'sha256');
        
        const cipher = crypto.createCipheriv(this.encryption.algorithm, key, iv);
        
        let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        
        return {
            encrypted,
            salt: salt.toString('hex'),
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex')
        };
    }

    // Encryption: Decrypt data
    decrypt(encryptedData) {
        const salt = Buffer.from(encryptedData.salt, 'hex');
        const iv = Buffer.from(encryptedData.iv, 'hex');
        const authTag = Buffer.from(encryptedData.authTag, 'hex');
        
        // Derive key from salt
        const key = crypto.pbkdf2Sync(this.encryption.key, salt, 100000, 32, 'sha256');
        
        const decipher = crypto.createDecipheriv(this.encryption.algorithm, key, iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return JSON.parse(decrypted);
    }

    // Request Signing: Sign request
    signRequest(request) {
        if (!this.signing.enabled) return request;
        
        const timestamp = Date.now();
        const payload = `${request.method}:${request.path}:${timestamp}:${JSON.stringify(request.body || {})}`;
        
        const signature = crypto
            .createHmac(this.signing.algorithm, this.signing.secret)
            .update(payload)
            .digest('hex');
        
        request.headers = request.headers || {};
        request.headers['X-Signature'] = signature;
        request.headers['X-Timestamp'] = timestamp;
        
        return request;
    }

    // Request Signing: Verify signature
    verifySignature(request) {
        if (!this.signing.enabled) return { valid: true };
        
        this.stats.signatureVerifications++;
        
        const signature = request.headers['x-signature'];
        const timestamp = request.headers['x-timestamp'];
        
        if (!signature || !timestamp) {
            return { valid: false, error: 'Missing signature headers' };
        }
        
        // Check timestamp age
        const age = Date.now() - parseInt(timestamp);
        if (age > this.signing.maxAge) {
            return { valid: false, error: 'Signature expired' };
        }
        
        // Recreate signature
        const payload = `${request.method}:${request.path}:${timestamp}:${JSON.stringify(request.body || {})}`;
        
        const expectedSignature = crypto
            .createHmac(this.signing.algorithm, this.signing.secret)
            .update(payload)
            .digest('hex');
        
        if (signature !== expectedSignature) {
            return { valid: false, error: 'Invalid signature' };
        }
        
        return { valid: true };
    }

    // Middleware: Security middleware for Express
    middleware() {
        return async (req, res, next) => {
            // Check IP address
            const ipCheck = this.checkIPAddress(req.ip);
            if (!ipCheck.allowed) {
                return res.status(403).json({
                    error: 'Forbidden',
                    message: ipCheck.reason
                });
            }
            
            // Verify API key if present
            const apiKey = req.headers['x-api-key'];
            if (apiKey) {
                const keyCheck = await this.verifyAPIKey(apiKey);
                if (!keyCheck.valid) {
                    return res.status(401).json({
                        error: 'Unauthorized',
                        message: keyCheck.error
                    });
                }
                req.apiKey = keyCheck.apiKey;
            }
            
            // Verify signature if required
            const sigCheck = this.verifySignature(req);
            if (!sigCheck.valid) {
                return res.status(401).json({
                    error: 'Unauthorized',
                    message: sigCheck.error
                });
            }
            
            // Apply security headers
            this.applySecurityHeaders(res);
            
            // Check mTLS if enabled (handled at TLS level)
            if (req.socket.encrypted && this.mtls.enabled) {
                const certCheck = this.verifyClientCertificate(req.socket);
                if (!certCheck.valid) {
                    return res.status(401).json({
                        error: 'Unauthorized',
                        message: certCheck.error
                    });
                }
                req.clientCertificate = certCheck.certificate;
            }
            
            next();
        };
    }

    // Get statistics
    getStats() {
        return {
            mtls: {
                connections: this.stats.mtlsConnections,
                rejections: this.stats.mtlsRejections,
                trustedCerts: this.mtls.clientCerts.size
            },
            apiKeys: {
                verifications: this.stats.apiKeyVerifications,
                rejections: this.stats.apiKeyRejections,
                activeKeys: this.apiKeys.storage.size
            },
            ipFilter: {
                allowed: this.stats.ipAllowed,
                blocked: this.stats.ipBlocked,
                whitelistSize: this.ipFilter.whitelist.size,
                blacklistSize: this.ipFilter.blacklist.size
            },
            encryption: {
                encryptedData: this.stats.encryptedData
            },
            signing: {
                verifications: this.stats.signatureVerifications
            }
        };
    }
}

module.exports = AdvancedSecurity;