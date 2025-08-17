const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

class AuthManager {
    constructor(database) {
        this.db = database;
        this.jwtSecret = process.env.JWT_SECRET || 'default-secret-change-this';
        this.tokenExpiry = '24h';
        this.refreshTokenExpiry = '7d';
    }

    async register(req, res) {
        try {
            const { username, password, email } = req.body;

            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required' });
            }

            const existingUser = await this.db.getUser(username);
            if (existingUser) {
                return res.status(409).json({ error: 'User already exists' });
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            
            const user = await this.db.createUser({
                username,
                password: hashedPassword,
                email,
                createdAt: new Date().toISOString()
            });

            const token = this.generateToken(user);
            const refreshToken = this.generateRefreshToken(user);

            res.json({
                message: 'User registered successfully',
                token,
                refreshToken,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email
                }
            });
        } catch (error) {
            res.status(500).json({ error: 'Registration failed', details: error.message });
        }
    }

    async login(req, res) {
        try {
            const { username, password } = req.body;

            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required' });
            }

            const user = await this.db.getUser(username);
            if (!user) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            await this.db.updateUserLastLogin(user.id);

            const token = this.generateToken(user);
            const refreshToken = this.generateRefreshToken(user);

            res.json({
                message: 'Login successful',
                token,
                refreshToken,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email
                }
            });
        } catch (error) {
            res.status(500).json({ error: 'Login failed', details: error.message });
        }
    }

    async refresh(req, res) {
        try {
            const { refreshToken } = req.body;

            if (!refreshToken) {
                return res.status(400).json({ error: 'Refresh token is required' });
            }

            const decoded = jwt.verify(refreshToken, this.jwtSecret);
            const user = await this.db.getUserById(decoded.userId);

            if (!user) {
                return res.status(401).json({ error: 'Invalid refresh token' });
            }

            const newToken = this.generateToken(user);
            const newRefreshToken = this.generateRefreshToken(user);

            res.json({
                token: newToken,
                refreshToken: newRefreshToken
            });
        } catch (error) {
            res.status(401).json({ error: 'Invalid refresh token' });
        }
    }

    async authenticate(req, res, next) {
        try {
            const token = this.extractToken(req);

            if (!token) {
                return res.status(401).json({ error: 'No token provided' });
            }

            const decoded = jwt.verify(token, this.jwtSecret);
            const user = await this.db.getUserById(decoded.userId);

            if (!user) {
                return res.status(401).json({ error: 'Invalid token' });
            }

            req.user = {
                id: user.id,
                username: user.username,
                email: user.email
            };

            await this.db.logUserActivity(user.id, {
                action: 'proxy_request',
                timestamp: new Date().toISOString(),
                ip: req.ip,
                path: req.path
            });

            next();
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token expired' });
            }
            return res.status(401).json({ error: 'Invalid token' });
        }
    }

    extractToken(req) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            return authHeader.substring(7);
        }
        
        if (req.cookies && req.cookies.token) {
            return req.cookies.token;
        }

        if (req.query.token) {
            return req.query.token;
        }

        return null;
    }

    generateToken(user) {
        return jwt.sign(
            { 
                userId: user.id, 
                username: user.username 
            },
            this.jwtSecret,
            { expiresIn: this.tokenExpiry }
        );
    }

    generateRefreshToken(user) {
        return jwt.sign(
            { 
                userId: user.id, 
                type: 'refresh' 
            },
            this.jwtSecret,
            { expiresIn: this.refreshTokenExpiry }
        );
    }

    async validateApiKey(apiKey) {
        const keyData = await this.db.getApiKey(apiKey);
        if (!keyData || !keyData.active) {
            return null;
        }

        await this.db.updateApiKeyLastUsed(apiKey);
        return keyData;
    }

    async createApiKey(userId, name) {
        const apiKey = this.generateApiKey();
        await this.db.createApiKey({
            key: apiKey,
            userId,
            name,
            createdAt: new Date().toISOString(),
            active: true
        });
        return apiKey;
    }

    generateApiKey() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let key = 'px_';
        for (let i = 0; i < 32; i++) {
            key += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return key;
    }
}

module.exports = AuthManager;