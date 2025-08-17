class ResponseModifier {
    constructor() {
        this.rules = [];
    }

    async modify(proxyRes, context) {
        const modified = {
            headers: { ...proxyRes.headers },
            statusCode: proxyRes.statusCode
        };

        modified.headers['X-Proxy-Response-Time'] = new Date().toISOString();
        modified.headers['X-Proxy-Target'] = context.targetUrl;
        
        delete modified.headers['x-powered-by'];
        delete modified.headers['server'];
        
        modified.headers['X-Content-Type-Options'] = 'nosniff';
        modified.headers['X-Frame-Options'] = 'SAMEORIGIN';
        modified.headers['X-XSS-Protection'] = '1; mode=block';

        for (const rule of this.rules) {
            if (rule.matches(proxyRes, context)) {
                await rule.apply(modified);
            }
        }

        return modified;
    }

    addRule(rule) {
        this.rules.push(rule);
    }

    removeRule(ruleId) {
        this.rules = this.rules.filter(r => r.id !== ruleId);
    }

    addHeaderRule(pattern, headerName, headerValue) {
        this.addRule({
            id: `response-header-${Date.now()}`,
            matches: (proxyRes, context) => {
                return new RegExp(pattern).test(context.targetUrl);
            },
            apply: async (modified) => {
                modified.headers[headerName] = headerValue;
            }
        });
    }

    addCorsRule(origins = '*') {
        this.addRule({
            id: `cors-${Date.now()}`,
            matches: () => true,
            apply: async (modified) => {
                modified.headers['Access-Control-Allow-Origin'] = origins;
                modified.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
                modified.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
                modified.headers['Access-Control-Allow-Credentials'] = 'true';
            }
        });
    }

    addCompressionRule() {
        this.addRule({
            id: `compression-${Date.now()}`,
            matches: (proxyRes) => {
                const contentType = proxyRes.headers['content-type'];
                return contentType && (
                    contentType.includes('text/') ||
                    contentType.includes('application/json') ||
                    contentType.includes('application/javascript')
                );
            },
            apply: async (modified) => {
                modified.headers['Content-Encoding'] = 'gzip';
            }
        });
    }
}

module.exports = ResponseModifier;