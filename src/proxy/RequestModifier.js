class RequestModifier {
    constructor() {
        this.rules = [];
    }

    async modify(req, context) {
        const modified = {
            headers: { ...req.headers },
            body: req.body,
            query: req.query,
            params: req.params
        };

        delete modified.headers['host'];
        delete modified.headers['connection'];
        
        modified.headers['X-Real-IP'] = req.ip;
        modified.headers['X-Forwarded-Time'] = new Date().toISOString();
        
        if (context.type === 'forward') {
            modified.headers['X-Proxy-Type'] = 'forward';
        } else if (context.type === 'reverse') {
            modified.headers['X-Proxy-Type'] = 'reverse';
        }

        for (const rule of this.rules) {
            if (rule.matches(req, context)) {
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
            id: `header-${Date.now()}`,
            matches: (req, context) => {
                return new RegExp(pattern).test(context.targetUrl);
            },
            apply: async (modified) => {
                modified.headers[headerName] = headerValue;
            }
        });
    }

    addRewriteRule(pattern, rewrite) {
        this.addRule({
            id: `rewrite-${Date.now()}`,
            matches: (req, context) => {
                return new RegExp(pattern).test(req.path);
            },
            apply: async (modified) => {
                modified.path = req.path.replace(new RegExp(pattern), rewrite);
            }
        });
    }

    addAuthRule(pattern, authHeader) {
        this.addRule({
            id: `auth-${Date.now()}`,
            matches: (req, context) => {
                return new RegExp(pattern).test(context.targetUrl);
            },
            apply: async (modified) => {
                modified.headers['Authorization'] = authHeader;
            }
        });
    }
}

module.exports = RequestModifier;