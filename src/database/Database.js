const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class Database {
    constructor() {
        this.dbPath = process.env.DATABASE_PATH || './data/proxy.db';
        this.db = null;
    }

    async initialize() {
        return new Promise((resolve, reject) => {
            const dbDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    reject(err);
                } else {
                    this.createTables().then(resolve).catch(reject);
                }
            });
        });
    }

    async createTables() {
        const queries = [
            `CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                email TEXT,
                createdAt TEXT,
                lastLogin TEXT,
                active INTEGER DEFAULT 1
            )`,
            `CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                userId INTEGER,
                name TEXT,
                createdAt TEXT,
                lastUsed TEXT,
                active INTEGER DEFAULT 1,
                FOREIGN KEY (userId) REFERENCES users(id)
            )`,
            `CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId INTEGER,
                action TEXT,
                timestamp TEXT,
                ip TEXT,
                path TEXT,
                details TEXT,
                FOREIGN KEY (userId) REFERENCES users(id)
            )`,
            `CREATE TABLE IF NOT EXISTS proxy_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                type TEXT,
                pattern TEXT,
                target TEXT,
                priority INTEGER DEFAULT 0,
                active INTEGER DEFAULT 1,
                createdAt TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS blocked_ips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip TEXT UNIQUE NOT NULL,
                reason TEXT,
                blockedAt TEXT,
                expiresAt TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS cache_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT UNIQUE NOT NULL,
                response TEXT,
                headers TEXT,
                createdAt TEXT,
                expiresAt TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT,
                requests INTEGER,
                errors INTEGER,
                avgResponseTime REAL,
                bandwidth INTEGER
            )`,
            `CREATE TABLE IF NOT EXISTS domains (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT UNIQUE NOT NULL,
                type TEXT DEFAULT 'reverse',
                ssl_enabled INTEGER DEFAULT 1,
                force_ssl INTEGER DEFAULT 0,
                active INTEGER DEFAULT 1,
                createdAt TEXT,
                updatedAt TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS subdomains (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domainId INTEGER,
                subdomain TEXT NOT NULL,
                path_prefix TEXT,
                strip_path INTEGER DEFAULT 0,
                active INTEGER DEFAULT 1,
                createdAt TEXT,
                FOREIGN KEY (domainId) REFERENCES domains(id),
                UNIQUE(domainId, subdomain)
            )`,
            `CREATE TABLE IF NOT EXISTS backends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                type TEXT DEFAULT 'internal',
                weight INTEGER DEFAULT 1,
                max_fails INTEGER DEFAULT 3,
                fail_timeout INTEGER DEFAULT 30,
                health_check_path TEXT DEFAULT '/health',
                health_check_interval INTEGER DEFAULT 30000,
                active INTEGER DEFAULT 1,
                healthy INTEGER DEFAULT 1,
                last_check TEXT,
                response_time INTEGER,
                createdAt TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS domain_backends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domainId INTEGER,
                subdomainId INTEGER,
                backendId INTEGER,
                priority INTEGER DEFAULT 0,
                load_balance_method TEXT DEFAULT 'round_robin',
                sticky_sessions INTEGER DEFAULT 0,
                createdAt TEXT,
                FOREIGN KEY (domainId) REFERENCES domains(id),
                FOREIGN KEY (subdomainId) REFERENCES subdomains(id),
                FOREIGN KEY (backendId) REFERENCES backends(id)
            )`,
            `CREATE TABLE IF NOT EXISTS proxmox_resources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vmid INTEGER UNIQUE NOT NULL,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                node TEXT NOT NULL,
                hostname TEXT,
                ip TEXT,
                port INTEGER DEFAULT 80,
                backend_id INTEGER,
                last_seen TEXT,
                createdAt TEXT,
                FOREIGN KEY (backend_id) REFERENCES backends(id)
            )`,
            `CREATE TABLE IF NOT EXISTS proxmox_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host TEXT NOT NULL,
                port INTEGER DEFAULT 8006,
                username TEXT NOT NULL,
                realm TEXT DEFAULT 'pam',
                domain TEXT DEFAULT 'local',
                sync_interval INTEGER DEFAULT 60000,
                auto_create_domains INTEGER DEFAULT 1,
                naming_pattern TEXT DEFAULT '{name}.{domain}',
                enabled INTEGER DEFAULT 1,
                last_sync TEXT,
                createdAt TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS cloudflare_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT,
                api_key TEXT,
                api_token TEXT,
                account_id TEXT,
                tunnel_enabled INTEGER DEFAULT 0,
                tunnel_id TEXT,
                auto_ssl INTEGER DEFAULT 1,
                auto_dns INTEGER DEFAULT 1,
                proxied INTEGER DEFAULT 1,
                public_ip TEXT,
                enabled INTEGER DEFAULT 1,
                last_sync TEXT,
                createdAt TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS cloudflare_domains (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain_id INTEGER,
                zone_id TEXT,
                zone_name TEXT,
                dns_record_id TEXT,
                record_type TEXT,
                record_content TEXT,
                proxied INTEGER DEFAULT 1,
                ssl_status TEXT,
                certificate_id TEXT,
                last_updated TEXT,
                FOREIGN KEY (domain_id) REFERENCES domains(id)
            )`,
            `CREATE TABLE IF NOT EXISTS cloudflare_tunnels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tunnel_id TEXT UNIQUE NOT NULL,
                tunnel_name TEXT NOT NULL,
                tunnel_secret TEXT,
                credentials_path TEXT,
                config_path TEXT,
                hostname TEXT,
                status TEXT DEFAULT 'inactive',
                pid INTEGER,
                createdAt TEXT
            )`
        ];

        for (const query of queries) {
            await this.run(query);
        }

        await this.createDefaultAdmin();
    }

    async createDefaultAdmin() {
        const bcrypt = require('bcrypt');
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';
        
        const existingAdmin = await this.getUser(adminUsername);
        if (!existingAdmin) {
            const hashedPassword = await bcrypt.hash(adminPassword, 10);
            await this.createUser({
                username: adminUsername,
                password: hashedPassword,
                email: 'admin@localhost',
                createdAt: new Date().toISOString()
            });
        }
    }

    run(query, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(query, params, function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, changes: this.changes });
            });
        });
    }

    get(query, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(query, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    all(query, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async createUser(userData) {
        const { username, password, email, createdAt } = userData;
        const result = await this.run(
            'INSERT INTO users (username, password, email, createdAt) VALUES (?, ?, ?, ?)',
            [username, password, email, createdAt]
        );
        return { id: result.id, username, email };
    }

    async getUser(username) {
        return this.get('SELECT * FROM users WHERE username = ?', [username]);
    }

    async getUserById(id) {
        return this.get('SELECT * FROM users WHERE id = ?', [id]);
    }

    async updateUserLastLogin(userId) {
        return this.run(
            'UPDATE users SET lastLogin = ? WHERE id = ?',
            [new Date().toISOString(), userId]
        );
    }

    async logUserActivity(userId, activity) {
        const { action, timestamp, ip, path } = activity;
        return this.run(
            'INSERT INTO activity_logs (userId, action, timestamp, ip, path) VALUES (?, ?, ?, ?, ?)',
            [userId, action, timestamp, ip, path]
        );
    }

    async createApiKey(keyData) {
        const { key, userId, name, createdAt, active } = keyData;
        return this.run(
            'INSERT INTO api_keys (key, userId, name, createdAt, active) VALUES (?, ?, ?, ?, ?)',
            [key, userId, name, createdAt, active]
        );
    }

    async getApiKey(key) {
        return this.get('SELECT * FROM api_keys WHERE key = ?', [key]);
    }

    async updateApiKeyLastUsed(key) {
        return this.run(
            'UPDATE api_keys SET lastUsed = ? WHERE key = ?',
            [new Date().toISOString(), key]
        );
    }

    async getProxyRules() {
        return this.all('SELECT * FROM proxy_rules WHERE active = 1 ORDER BY priority DESC');
    }

    async addProxyRule(rule) {
        const { name, type, pattern, target, priority } = rule;
        return this.run(
            'INSERT INTO proxy_rules (name, type, pattern, target, priority, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
            [name, type, pattern, target, priority, new Date().toISOString()]
        );
    }

    async isIpBlocked(ip) {
        const blocked = await this.get(
            'SELECT * FROM blocked_ips WHERE ip = ? AND (expiresAt IS NULL OR expiresAt > ?)',
            [ip, new Date().toISOString()]
        );
        return !!blocked;
    }

    async blockIp(ip, reason, duration = null) {
        const expiresAt = duration ? new Date(Date.now() + duration).toISOString() : null;
        return this.run(
            'INSERT OR REPLACE INTO blocked_ips (ip, reason, blockedAt, expiresAt) VALUES (?, ?, ?, ?)',
            [ip, reason, new Date().toISOString(), expiresAt]
        );
    }

    async getMetrics(startTime, endTime) {
        return this.all(
            'SELECT * FROM metrics WHERE timestamp >= ? AND timestamp <= ?',
            [startTime, endTime]
        );
    }

    async recordMetric(metric) {
        const { requests, errors, avgResponseTime, bandwidth } = metric;
        return this.run(
            'INSERT INTO metrics (timestamp, requests, errors, avgResponseTime, bandwidth) VALUES (?, ?, ?, ?, ?)',
            [new Date().toISOString(), requests, errors, avgResponseTime, bandwidth]
        );
    }

    async cleanupOldData(daysToKeep = 30) {
        const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
        await this.run('DELETE FROM activity_logs WHERE timestamp < ?', [cutoffDate]);
        await this.run('DELETE FROM metrics WHERE timestamp < ?', [cutoffDate]);
        await this.run('DELETE FROM cache_entries WHERE expiresAt < ?', [new Date().toISOString()]);
    }

    // Domain management methods
    async createDomain(domain, type = 'reverse') {
        return this.run(
            'INSERT INTO domains (domain, type, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
            [domain, type, new Date().toISOString(), new Date().toISOString()]
        );
    }

    async getDomains() {
        return this.all('SELECT * FROM domains WHERE active = 1 ORDER BY domain');
    }

    async getDomain(domain) {
        return this.get('SELECT * FROM domains WHERE domain = ? AND active = 1', [domain]);
    }

    async createSubdomain(domainId, subdomain, pathPrefix = null, stripPath = false) {
        return this.run(
            'INSERT INTO subdomains (domainId, subdomain, path_prefix, strip_path, createdAt) VALUES (?, ?, ?, ?, ?)',
            [domainId, subdomain, pathPrefix, stripPath ? 1 : 0, new Date().toISOString()]
        );
    }

    async getSubdomains(domainId) {
        return this.all('SELECT * FROM subdomains WHERE domainId = ? AND active = 1', [domainId]);
    }

    // Backend management methods
    async createBackend(backendData) {
        const { name, url, type = 'internal', weight = 1, healthCheckPath = '/health' } = backendData;
        return this.run(
            'INSERT INTO backends (name, url, type, weight, health_check_path, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
            [name, url, type, weight, healthCheckPath, new Date().toISOString()]
        );
    }

    async getBackends() {
        return this.all('SELECT * FROM backends WHERE active = 1 ORDER BY name');
    }

    async getHealthyBackends() {
        return this.all('SELECT * FROM backends WHERE active = 1 AND healthy = 1');
    }

    async updateBackendHealth(backendId, healthy, responseTime = null) {
        return this.run(
            'UPDATE backends SET healthy = ?, last_check = ?, response_time = ? WHERE id = ?',
            [healthy ? 1 : 0, new Date().toISOString(), responseTime, backendId]
        );
    }

    // Domain-Backend mapping methods
    async assignBackendToDomain(domainId, backendId, subdomainId = null, loadBalanceMethod = 'round_robin') {
        return this.run(
            'INSERT INTO domain_backends (domainId, subdomainId, backendId, load_balance_method, createdAt) VALUES (?, ?, ?, ?, ?)',
            [domainId, subdomainId, backendId, loadBalanceMethod, new Date().toISOString()]
        );
    }

    async getBackendsForDomain(domainId, subdomainId = null) {
        let query = `
            SELECT b.*, db.load_balance_method, db.priority 
            FROM backends b 
            JOIN domain_backends db ON b.id = db.backendId 
            WHERE db.domainId = ? AND b.active = 1
        `;
        const params = [domainId];
        
        if (subdomainId) {
            query += ' AND db.subdomainId = ?';
            params.push(subdomainId);
        } else {
            query += ' AND db.subdomainId IS NULL';
        }
        
        query += ' ORDER BY db.priority, b.weight DESC';
        
        return this.all(query, params);
    }
    
    // Get all backends for domain including unhealthy ones (for admin panel)
    async getAllBackendsForDomain(domainId) {
        const query = `
            SELECT b.*, db.load_balance_method, db.priority, db.id as assignment_id,
                   s.subdomain, db.subdomainId
            FROM backends b 
            JOIN domain_backends db ON b.id = db.backendId 
            LEFT JOIN subdomains s ON db.subdomainId = s.id
            WHERE db.domainId = ? AND b.active = 1
            ORDER BY s.subdomain, db.priority, b.weight DESC
        `;
        return this.all(query, [domainId]);
    }

    async getDomainRouting(host) {
        const parts = host.split('.');
        let domain = null;
        let subdomain = null;
        
        if (parts.length >= 2) {
            domain = parts.slice(-2).join('.');
            if (parts.length > 2) {
                subdomain = parts.slice(0, -2).join('.');
            }
        }
        
        const domainRecord = await this.getDomain(domain);
        if (!domainRecord) return null;
        
        let subdomainRecord = null;
        if (subdomain) {
            subdomainRecord = await this.get(
                'SELECT * FROM subdomains WHERE domainId = ? AND subdomain = ? AND active = 1',
                [domainRecord.id, subdomain]
            );
        }
        
        const backends = await this.getBackendsForDomain(domainRecord.id, subdomainRecord?.id);
        
        return {
            domain: domainRecord,
            subdomain: subdomainRecord,
            backends
        };
    }
}

module.exports = Database;