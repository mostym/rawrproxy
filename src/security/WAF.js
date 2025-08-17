const Logger = require('../utils/Logger');

class WAF {
    constructor(options = {}) {
        this.logger = new Logger();
        this.enabled = options.enabled !== false;
        this.blockOnMatch = options.blockOnMatch !== false;
        this.logOnly = options.logOnly || false;
        
        // Statistics
        this.stats = {
            requests: 0,
            blocked: 0,
            passed: 0,
            violations: new Map()
        };

        // Initialize rule sets
        this.rules = {
            sqlInjection: this.getSqlInjectionRules(),
            xss: this.getXssRules(),
            pathTraversal: this.getPathTraversalRules(),
            commandInjection: this.getCommandInjectionRules(),
            xxe: this.getXxeRules(),
            headers: this.getHeaderRules(),
            methods: this.getMethodRules(),
            fileUpload: this.getFileUploadRules(),
            rateLimit: this.getRateLimitRules()
        };

        this.logger.info('WAF initialized');
    }

    // Main inspection method
    async inspect(req, res) {
        if (!this.enabled) return { allowed: true };

        this.stats.requests++;
        const violations = [];
        const context = this.buildContext(req);

        // Check all rule categories
        for (const [category, rules] of Object.entries(this.rules)) {
            for (const rule of rules) {
                if (rule.enabled !== false) {
                    const violation = this.checkRule(rule, context);
                    if (violation) {
                        violations.push({
                            category,
                            rule: rule.name,
                            severity: rule.severity,
                            match: violation
                        });
                    }
                }
            }
        }

        // Process violations
        if (violations.length > 0) {
            this.handleViolations(violations, req);
            
            const shouldBlock = this.shouldBlock(violations);
            if (shouldBlock && !this.logOnly) {
                this.stats.blocked++;
                return {
                    allowed: false,
                    violations,
                    action: 'BLOCK'
                };
            }
        }

        this.stats.passed++;
        return {
            allowed: true,
            violations
        };
    }

    buildContext(req) {
        return {
            method: req.method,
            path: req.path,
            query: req.query || {},
            headers: req.headers || {},
            body: req.body || {},
            cookies: req.cookies || {},
            ip: req.ip || req.connection.remoteAddress,
            url: req.url,
            userAgent: req.headers['user-agent'] || ''
        };
    }

    checkRule(rule, context) {
        try {
            const targets = rule.targets || ['url', 'query', 'body', 'headers'];
            
            for (const target of targets) {
                const value = this.getTargetValue(target, context);
                if (value && rule.pattern) {
                    const match = this.matchPattern(rule.pattern, value);
                    if (match) {
                        return {
                            target,
                            value: this.sanitizeLogValue(value),
                            pattern: rule.pattern.toString()
                        };
                    }
                }
            }
        } catch (error) {
            this.logger.error(`Rule check error: ${error.message}`);
        }
        return null;
    }

    getTargetValue(target, context) {
        switch (target) {
            case 'url':
                return context.url;
            case 'path':
                return context.path;
            case 'query':
                return JSON.stringify(context.query);
            case 'body':
                return typeof context.body === 'string' 
                    ? context.body 
                    : JSON.stringify(context.body);
            case 'headers':
                return JSON.stringify(context.headers);
            case 'cookies':
                return JSON.stringify(context.cookies);
            case 'method':
                return context.method;
            case 'user-agent':
                return context.userAgent;
            default:
                return null;
        }
    }

    matchPattern(pattern, value) {
        if (pattern instanceof RegExp) {
            return pattern.test(value);
        }
        if (typeof pattern === 'string') {
            return value.toLowerCase().includes(pattern.toLowerCase());
        }
        if (typeof pattern === 'function') {
            return pattern(value);
        }
        return false;
    }

    shouldBlock(violations) {
        if (!this.blockOnMatch) return false;
        
        // Block if any critical or high severity violation
        return violations.some(v => 
            v.severity === 'CRITICAL' || v.severity === 'HIGH'
        );
    }

    handleViolations(violations, req) {
        for (const violation of violations) {
            // Update statistics
            const key = `${violation.category}:${violation.rule}`;
            this.stats.violations.set(
                key, 
                (this.stats.violations.get(key) || 0) + 1
            );

            // Log violation
            this.logger.warn(`WAF Violation: ${JSON.stringify({
                category: violation.category,
                rule: violation.rule,
                severity: violation.severity,
                ip: req.ip,
                path: req.path,
                method: req.method
            })}`);
        }
    }

    sanitizeLogValue(value) {
        const str = String(value);
        if (str.length > 100) {
            return str.substring(0, 100) + '...';
        }
        return str;
    }

    // SQL Injection rules
    getSqlInjectionRules() {
        return [
            {
                name: 'SQL_KEYWORDS',
                pattern: /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|FROM|WHERE|ORDER BY|GROUP BY|HAVING)\b)/gi,
                severity: 'HIGH',
                enabled: true
            },
            {
                name: 'SQL_COMMENTS',
                pattern: /(--|#|\/\*|\*\/)/g,
                severity: 'MEDIUM',
                enabled: true
            },
            {
                name: 'SQL_METACHARACTERS',
                pattern: /('|"|;|\\x00|\\n|\\r|\\x1a)/g,
                severity: 'MEDIUM',
                enabled: true
            },
            {
                name: 'SQL_TAUTOLOGY',
                pattern: /(\bOR\b\s*\d+\s*=\s*\d+|\bAND\b\s*\d+\s*=\s*\d+|'\s*OR\s*'|"\s*OR\s*")/gi,
                severity: 'HIGH',
                enabled: true
            },
            {
                name: 'SQL_BENCHMARK',
                pattern: /\b(BENCHMARK|SLEEP|WAITFOR|PG_SLEEP)\b/gi,
                severity: 'HIGH',
                enabled: true
            }
        ];
    }

    // XSS rules
    getXssRules() {
        return [
            {
                name: 'XSS_SCRIPT_TAG',
                pattern: /<script[^>]*>.*?<\/script>/gi,
                severity: 'CRITICAL',
                enabled: true
            },
            {
                name: 'XSS_EVENT_HANDLERS',
                pattern: /\b(on\w+)\s*=\s*["']?[^"']*["']?/gi,
                severity: 'HIGH',
                enabled: true
            },
            {
                name: 'XSS_JAVASCRIPT_URI',
                pattern: /javascript\s*:/gi,
                severity: 'HIGH',
                enabled: true
            },
            {
                name: 'XSS_DATA_URI',
                pattern: /data:[^,]*script/gi,
                severity: 'HIGH',
                enabled: true
            },
            {
                name: 'XSS_HTML_ENTITIES',
                pattern: /(&lt;|&gt;|&#x|&#\d)/gi,
                severity: 'LOW',
                enabled: true
            },
            {
                name: 'XSS_IFRAME',
                pattern: /<iframe[^>]*>/gi,
                severity: 'MEDIUM',
                enabled: true
            }
        ];
    }

    // Path Traversal rules
    getPathTraversalRules() {
        return [
            {
                name: 'PATH_TRAVERSAL_DOTS',
                pattern: /\.\.[\/\\]/g,
                severity: 'HIGH',
                enabled: true,
                targets: ['url', 'path', 'query']
            },
            {
                name: 'PATH_TRAVERSAL_ENCODED',
                pattern: /%2e%2e[%2f%5c]/gi,
                severity: 'HIGH',
                enabled: true,
                targets: ['url', 'path', 'query']
            },
            {
                name: 'PATH_SENSITIVE_FILES',
                pattern: /\/(etc\/passwd|etc\/shadow|windows\/win\.ini|boot\.ini)/gi,
                severity: 'CRITICAL',
                enabled: true,
                targets: ['url', 'path', 'query']
            }
        ];
    }

    // Command Injection rules
    getCommandInjectionRules() {
        return [
            {
                name: 'CMD_UNIX_COMMANDS',
                pattern: /\b(ls|cat|grep|wget|curl|chmod|chown|sudo|su|passwd|shadow)\b/gi,
                severity: 'HIGH',
                enabled: true
            },
            {
                name: 'CMD_WINDOWS_COMMANDS',
                pattern: /\b(cmd|powershell|net user|net localgroup|reg add|reg query)\b/gi,
                severity: 'HIGH',
                enabled: true
            },
            {
                name: 'CMD_SEPARATORS',
                pattern: /(;|\||&&|\|\||`|\$\()/g,
                severity: 'MEDIUM',
                enabled: true
            },
            {
                name: 'CMD_REDIRECTION',
                pattern: /(>|>>|<|2>&1)/g,
                severity: 'MEDIUM',
                enabled: true
            }
        ];
    }

    // XXE rules
    getXxeRules() {
        return [
            {
                name: 'XXE_DOCTYPE',
                pattern: /<!DOCTYPE[^>]*\[.*\]>/gi,
                severity: 'HIGH',
                enabled: true,
                targets: ['body']
            },
            {
                name: 'XXE_ENTITY',
                pattern: /<!ENTITY/gi,
                severity: 'HIGH',
                enabled: true,
                targets: ['body']
            },
            {
                name: 'XXE_SYSTEM',
                pattern: /SYSTEM\s+["'][^"']*["']/gi,
                severity: 'HIGH',
                enabled: true,
                targets: ['body']
            }
        ];
    }

    // Header rules
    getHeaderRules() {
        return [
            {
                name: 'HEADER_HOST_INJECTION',
                pattern: (value) => {
                    // Check for multiple hosts or suspicious characters
                    return /[<>{}\\]/.test(value) || value.split('.').length > 10;
                },
                severity: 'MEDIUM',
                enabled: true,
                targets: ['headers']
            },
            {
                name: 'HEADER_USER_AGENT_BOT',
                pattern: /\b(bot|crawler|spider|scraper|scan)\b/gi,
                severity: 'LOW',
                enabled: false, // Disabled by default as many legitimate bots exist
                targets: ['user-agent']
            }
        ];
    }

    // HTTP Method rules
    getMethodRules() {
        return [
            {
                name: 'METHOD_NOT_ALLOWED',
                pattern: (value) => {
                    const allowed = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
                    return !allowed.includes(value);
                },
                severity: 'MEDIUM',
                enabled: true,
                targets: ['method']
            },
            {
                name: 'METHOD_TRACE',
                pattern: /^TRACE$/,
                severity: 'HIGH',
                enabled: true,
                targets: ['method']
            }
        ];
    }

    // File Upload rules
    getFileUploadRules() {
        return [
            {
                name: 'FILE_EXTENSION_BLACKLIST',
                pattern: /\.(exe|dll|bat|cmd|com|pif|scr|vbs|js|jar|zip|rar|sh|ps1)$/gi,
                severity: 'HIGH',
                enabled: true,
                targets: ['body', 'query']
            },
            {
                name: 'FILE_DOUBLE_EXTENSION',
                pattern: /\.\w+\.\w+$/,
                severity: 'MEDIUM',
                enabled: true,
                targets: ['body', 'query']
            }
        ];
    }

    // Rate limiting rules (basic implementation)
    getRateLimitRules() {
        return [
            {
                name: 'RATE_LIMIT_EXCEEDED',
                pattern: (value) => {
                    // This would need to be implemented with actual rate limiting logic
                    return false;
                },
                severity: 'MEDIUM',
                enabled: false
            }
        ];
    }

    // Get statistics
    getStats() {
        const topViolations = Array.from(this.stats.violations.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([rule, count]) => ({ rule, count }));

        return {
            totalRequests: this.stats.requests,
            blocked: this.stats.blocked,
            passed: this.stats.passed,
            blockRate: this.stats.requests > 0 
                ? ((this.stats.blocked / this.stats.requests) * 100).toFixed(2) + '%'
                : '0%',
            topViolations
        };
    }

    // Enable/disable WAF
    enable() {
        this.enabled = true;
        this.logger.info('WAF enabled');
    }

    disable() {
        this.enabled = false;
        this.logger.info('WAF disabled');
    }

    // Update rules
    updateRule(category, ruleName, updates) {
        const rules = this.rules[category];
        if (rules) {
            const rule = rules.find(r => r.name === ruleName);
            if (rule) {
                Object.assign(rule, updates);
                this.logger.info(`WAF rule updated: ${category}/${ruleName}`);
                return true;
            }
        }
        return false;
    }

    // Add custom rule
    addCustomRule(category, rule) {
        if (!this.rules[category]) {
            this.rules[category] = [];
        }
        this.rules[category].push(rule);
        this.logger.info(`Custom WAF rule added: ${category}/${rule.name}`);
    }
}

module.exports = WAF;