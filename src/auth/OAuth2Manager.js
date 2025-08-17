const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2');
const OpenIDConnectStrategy = require('passport-openidconnect');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const crypto = require('crypto');
const Logger = require('../utils/Logger');

class OAuth2Manager {
    constructor(options = {}) {
        this.logger = new Logger();
        this.db = options.database;
        this.redisCache = options.redisCache;
        
        // Configuration
        this.providers = new Map();
        this.sessions = new Map();
        this.jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
        
        // Initialize passport
        this.passport = passport;
        this.setupPassport();
        
        this.logger.info('OAuth2/OIDC manager initialized');
    }

    // Setup passport serialization
    setupPassport() {
        this.passport.serializeUser((user, done) => {
            done(null, user.id || user.sub || user.email);
        });
        
        this.passport.deserializeUser(async (id, done) => {
            try {
                const user = await this.getUserById(id);
                done(null, user);
            } catch (error) {
                done(error, null);
            }
        });
    }

    // Register an OAuth2 provider
    registerOAuth2Provider(config) {
        const provider = {
            id: config.id,
            name: config.name,
            type: 'oauth2',
            enabled: config.enabled !== false,
            
            // OAuth2 configuration
            clientID: config.clientID,
            clientSecret: config.clientSecret,
            authorizationURL: config.authorizationURL,
            tokenURL: config.tokenURL,
            callbackURL: config.callbackURL,
            scope: config.scope || ['openid', 'profile', 'email'],
            
            // User profile mapping
            profileURL: config.profileURL,
            profileFields: config.profileFields || {},
            
            // Additional options
            pkce: config.pkce || false, // PKCE support
            state: config.state !== false, // State parameter for CSRF protection
            
            // Session configuration
            sessionTimeout: config.sessionTimeout || 3600000, // 1 hour
            refreshToken: config.refreshToken || false,
            
            // Callbacks
            onAuthenticated: config.onAuthenticated || null,
            onError: config.onError || null
        };
        
        // Create passport strategy
        const strategy = new OAuth2Strategy({
            clientID: provider.clientID,
            clientSecret: provider.clientSecret,
            authorizationURL: provider.authorizationURL,
            tokenURL: provider.tokenURL,
            callbackURL: provider.callbackURL,
            scope: provider.scope,
            state: provider.state,
            pkce: provider.pkce,
            passReqToCallback: true
        }, async (req, accessToken, refreshToken, params, profile, done) => {
            try {
                // Get user profile if not provided
                if (!profile && provider.profileURL) {
                    profile = await this.fetchUserProfile(provider, accessToken);
                }
                
                // Map profile to user object
                const user = this.mapProfile(profile, provider.profileFields);
                user.provider = provider.id;
                user.accessToken = accessToken;
                user.refreshToken = refreshToken;
                
                // Store or update user
                const savedUser = await this.saveUser(user);
                
                // Call callback if defined
                if (provider.onAuthenticated) {
                    await provider.onAuthenticated(savedUser, req);
                }
                
                done(null, savedUser);
            } catch (error) {
                this.logger.error(`OAuth2 authentication error: ${error.message}`);
                
                if (provider.onError) {
                    await provider.onError(error, req);
                }
                
                done(error, null);
            }
        });
        
        // Register strategy with passport
        this.passport.use(provider.id, strategy);
        this.providers.set(provider.id, provider);
        
        this.logger.info(`Registered OAuth2 provider: ${provider.name}`);
        return provider;
    }

    // Register an OpenID Connect provider
    registerOIDCProvider(config) {
        const provider = {
            id: config.id,
            name: config.name,
            type: 'oidc',
            enabled: config.enabled !== false,
            
            // OIDC configuration
            issuer: config.issuer,
            clientID: config.clientID,
            clientSecret: config.clientSecret,
            discoveryURL: config.discoveryURL || `${config.issuer}/.well-known/openid-configuration`,
            callbackURL: config.callbackURL,
            scope: config.scope || ['openid', 'profile', 'email'],
            
            // JWKS for token validation
            jwksUri: config.jwksUri || `${config.issuer}/.well-known/jwks.json`,
            
            // Token configuration
            idTokenSigningAlg: config.idTokenSigningAlg || 'RS256',
            userInfoURL: config.userInfoURL,
            
            // Session configuration
            sessionTimeout: config.sessionTimeout || 3600000,
            refreshToken: config.refreshToken || false,
            
            // Claims mapping
            claimsMapping: config.claimsMapping || {
                id: 'sub',
                email: 'email',
                name: 'name',
                picture: 'picture',
                groups: 'groups',
                roles: 'roles'
            },
            
            // Callbacks
            onAuthenticated: config.onAuthenticated || null,
            onError: config.onError || null
        };
        
        // Create passport strategy
        const strategy = new OpenIDConnectStrategy({
            issuer: provider.issuer,
            clientID: provider.clientID,
            clientSecret: provider.clientSecret,
            discoveryURL: provider.discoveryURL,
            callbackURL: provider.callbackURL,
            scope: provider.scope,
            passReqToCallback: true
        }, async (req, iss, sub, profile, accessToken, refreshToken, params, done) => {
            try {
                // Validate ID token if present
                if (params.id_token) {
                    const valid = await this.validateIdToken(provider, params.id_token);
                    if (!valid) {
                        throw new Error('Invalid ID token');
                    }
                }
                
                // Map claims to user object
                const user = this.mapClaims(profile, provider.claimsMapping);
                user.provider = provider.id;
                user.accessToken = accessToken;
                user.refreshToken = refreshToken;
                user.idToken = params.id_token;
                
                // Get additional user info if available
                if (provider.userInfoURL && accessToken) {
                    const userInfo = await this.fetchUserInfo(provider, accessToken);
                    Object.assign(user, userInfo);
                }
                
                // Store or update user
                const savedUser = await this.saveUser(user);
                
                // Call callback if defined
                if (provider.onAuthenticated) {
                    await provider.onAuthenticated(savedUser, req);
                }
                
                done(null, savedUser);
            } catch (error) {
                this.logger.error(`OIDC authentication error: ${error.message}`);
                
                if (provider.onError) {
                    await provider.onError(error, req);
                }
                
                done(error, null);
            }
        });
        
        // Register strategy with passport
        this.passport.use(provider.id, strategy);
        this.providers.set(provider.id, provider);
        
        // Setup JWKS client for token validation
        if (provider.jwksUri) {
            provider.jwksClient = jwksClient({
                jwksUri: provider.jwksUri,
                cache: true,
                cacheMaxAge: 600000 // 10 minutes
            });
        }
        
        this.logger.info(`Registered OIDC provider: ${provider.name}`);
        return provider;
    }

    // Validate ID token
    async validateIdToken(provider, idToken) {
        try {
            const decoded = jwt.decode(idToken, { complete: true });
            
            if (!decoded) {
                return false;
            }
            
            // Get signing key
            const key = await this.getSigningKey(provider, decoded.header.kid);
            
            // Verify token
            const verified = jwt.verify(idToken, key, {
                issuer: provider.issuer,
                audience: provider.clientID,
                algorithms: [provider.idTokenSigningAlg]
            });
            
            return verified;
        } catch (error) {
            this.logger.error(`ID token validation error: ${error.message}`);
            return false;
        }
    }

    // Get signing key from JWKS
    async getSigningKey(provider, kid) {
        return new Promise((resolve, reject) => {
            if (!provider.jwksClient) {
                reject(new Error('JWKS client not configured'));
                return;
            }
            
            provider.jwksClient.getSigningKey(kid, (error, key) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(key.getPublicKey());
                }
            });
        });
    }

    // Fetch user profile from OAuth2 provider
    async fetchUserProfile(provider, accessToken) {
        const axios = require('axios');
        
        try {
            const response = await axios.get(provider.profileURL, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                }
            });
            
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to fetch user profile: ${error.message}`);
            throw error;
        }
    }

    // Fetch user info from OIDC provider
    async fetchUserInfo(provider, accessToken) {
        const axios = require('axios');
        
        try {
            const response = await axios.get(provider.userInfoURL, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                }
            });
            
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to fetch user info: ${error.message}`);
            return {};
        }
    }

    // Map OAuth2 profile to user object
    mapProfile(profile, fields) {
        const user = {};
        
        for (const [key, path] of Object.entries(fields)) {
            const value = this.getNestedValue(profile, path);
            if (value !== undefined) {
                user[key] = value;
            }
        }
        
        // Default mappings
        user.id = user.id || profile.id || profile.sub;
        user.email = user.email || profile.email || profile.emails?.[0]?.value;
        user.name = user.name || profile.displayName || profile.name;
        user.picture = user.picture || profile.photos?.[0]?.value;
        
        return user;
    }

    // Map OIDC claims to user object
    mapClaims(profile, mapping) {
        const user = {};
        
        for (const [key, claim] of Object.entries(mapping)) {
            if (profile[claim] !== undefined) {
                user[key] = profile[claim];
            }
        }
        
        return user;
    }

    // Get nested value from object
    getNestedValue(obj, path) {
        const parts = path.split('.');
        let value = obj;
        
        for (const part of parts) {
            if (value && typeof value === 'object') {
                value = value[part];
            } else {
                return undefined;
            }
        }
        
        return value;
    }

    // Save or update user
    async saveUser(user) {
        try {
            // Store in database if available
            if (this.db) {
                const existing = await this.db.get(
                    'SELECT * FROM users WHERE provider = ? AND provider_id = ?',
                    [user.provider, user.id]
                );
                
                if (existing) {
                    await this.db.run(
                        `UPDATE users SET 
                         email = ?, name = ?, picture = ?, 
                         access_token = ?, refresh_token = ?, 
                         last_login = CURRENT_TIMESTAMP 
                         WHERE id = ?`,
                        [user.email, user.name, user.picture, 
                         user.accessToken, user.refreshToken, existing.id]
                    );
                    user.dbId = existing.id;
                } else {
                    const result = await this.db.run(
                        `INSERT INTO users 
                         (provider, provider_id, email, name, picture, 
                          access_token, refresh_token, created_at) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [user.provider, user.id, user.email, user.name, 
                         user.picture, user.accessToken, user.refreshToken]
                    );
                    user.dbId = result.lastID;
                }
            }
            
            // Store in Redis cache for session
            if (this.redisCache && this.redisCache.connected) {
                await this.redisCache.setSession(user.id, user, 3600);
            }
            
            return user;
        } catch (error) {
            this.logger.error(`Failed to save user: ${error.message}`);
            throw error;
        }
    }

    // Get user by ID
    async getUserById(id) {
        // Check Redis cache first
        if (this.redisCache && this.redisCache.connected) {
            const cached = await this.redisCache.getSession(id);
            if (cached) return cached;
        }
        
        // Check database
        if (this.db) {
            const user = await this.db.get(
                'SELECT * FROM users WHERE provider_id = ? OR id = ?',
                [id, id]
            );
            return user;
        }
        
        return null;
    }

    // Generate JWT token for user
    generateToken(user, expiresIn = '1h') {
        const payload = {
            id: user.id,
            email: user.email,
            name: user.name,
            provider: user.provider,
            roles: user.roles || [],
            groups: user.groups || []
        };
        
        return jwt.sign(payload, this.jwtSecret, {
            expiresIn: expiresIn,
            issuer: 'rawrproxy',
            audience: 'rawrproxy-api'
        });
    }

    // Verify JWT token
    verifyToken(token) {
        try {
            return jwt.verify(token, this.jwtSecret, {
                issuer: 'rawrproxy',
                audience: 'rawrproxy-api'
            });
        } catch (error) {
            this.logger.error(`Token verification error: ${error.message}`);
            return null;
        }
    }

    // Middleware to require authentication
    requireAuth(provider = null) {
        return (req, res, next) => {
            if (req.isAuthenticated()) {
                // Check if specific provider is required
                if (provider && req.user.provider !== provider) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: `Authentication with ${provider} required`
                    });
                }
                return next();
            }
            
            // Check for JWT token
            const token = this.extractToken(req);
            if (token) {
                const decoded = this.verifyToken(token);
                if (decoded) {
                    req.user = decoded;
                    return next();
                }
            }
            
            res.status(401).json({
                error: 'Unauthorized',
                message: 'Authentication required'
            });
        };
    }

    // Extract token from request
    extractToken(req) {
        // Check Authorization header
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            return authHeader.substring(7);
        }
        
        // Check cookie
        if (req.cookies && req.cookies.token) {
            return req.cookies.token;
        }
        
        // Check query parameter
        if (req.query && req.query.token) {
            return req.query.token;
        }
        
        return null;
    }

    // Get authentication routes
    getAuthRoutes() {
        const router = require('express').Router();
        
        // List providers
        router.get('/providers', (req, res) => {
            const providers = Array.from(this.providers.values())
                .filter(p => p.enabled)
                .map(p => ({
                    id: p.id,
                    name: p.name,
                    type: p.type
                }));
            
            res.json(providers);
        });
        
        // Initiate authentication
        router.get('/login/:provider', (req, res, next) => {
            const provider = this.providers.get(req.params.provider);
            
            if (!provider || !provider.enabled) {
                return res.status(404).json({
                    error: 'Provider not found'
                });
            }
            
            // Store return URL in session
            if (req.query.returnTo) {
                req.session.returnTo = req.query.returnTo;
            }
            
            this.passport.authenticate(req.params.provider, {
                scope: provider.scope
            })(req, res, next);
        });
        
        // Handle callback
        router.get('/callback/:provider', (req, res, next) => {
            const provider = this.providers.get(req.params.provider);
            
            if (!provider || !provider.enabled) {
                return res.status(404).json({
                    error: 'Provider not found'
                });
            }
            
            this.passport.authenticate(req.params.provider, {
                failureRedirect: '/auth/error',
                successRedirect: req.session.returnTo || '/'
            })(req, res, next);
        });
        
        // Get current user
        router.get('/me', this.requireAuth(), (req, res) => {
            res.json(req.user);
        });
        
        // Logout
        router.post('/logout', (req, res) => {
            req.logout();
            res.json({ message: 'Logged out successfully' });
        });
        
        // Error page
        router.get('/error', (req, res) => {
            res.status(401).json({
                error: 'Authentication failed',
                message: req.query.message || 'An error occurred during authentication'
            });
        });
        
        return router;
    }

    // Get statistics
    getStats() {
        return {
            providers: this.providers.size,
            enabledProviders: Array.from(this.providers.values()).filter(p => p.enabled).length,
            activeSessions: this.sessions.size
        };
    }
}

module.exports = OAuth2Manager;