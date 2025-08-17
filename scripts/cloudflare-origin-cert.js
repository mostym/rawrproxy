#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');
const Database = require('/opt/proxy/src/database/Database.js');

/**
 * Generate Cloudflare Origin Certificate
 * This uses the Cloudflare API v4 to create Origin certificates
 * These certificates are trusted by Cloudflare for Full (strict) SSL mode
 */

async function generateOriginCertificate() {
    // Get API credentials from database
    const db = new Database();
    await db.initialize();
    const config = await db.get('SELECT * FROM cloudflare_config WHERE enabled = 1');
    
    if (!config) {
        console.error('❌ Cloudflare not configured. Please configure through admin panel first.');
        process.exit(1);
    }

    console.log('🔐 Generating Cloudflare Origin Certificate...\n');
    console.log('ℹ️  Note: You need either:');
    console.log('   1. API Token with "Origin CA" permission, OR');
    console.log('   2. Global API Key (found at dash.cloudflare.com → My Profile → API Tokens → Global API Key)\n');

    // List of all your domains
    const domains = [
        '*.25bc.com', '25bc.com',
        '*.causejesus.xyz', 'causejesus.xyz',
        '*.namrots.com', 'namrots.com',
        '*.namrotsjh.com', 'namrotsjh.com',
        '*.rawrcorp.com', 'rawrcorp.com',
        '*.rawrinc.com', 'rawrinc.com',
        '*.rawrpix.com', 'rawrpix.com',
        '*.rawrtv.com', 'rawrtv.com',
        '*.singspot.com', 'singspot.com',
        '*.tektastic.com', 'tektastic.com',
        '*.tivi.to', 'tivi.to'
    ];

    // Generate private key locally
    const { generateKeyPairSync } = require('crypto');
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem'
        }
    });

    // Prepare the API request
    const requestData = JSON.stringify({
        hostnames: domains,
        requested_validity: 5475, // 15 years in days
        request_type: 'origin-rsa'
    });

    // Try the provided Origin CA key first
    const originCAKey = 'hloNJ6Mc_GvH2IXobxMmvAteh1aNAnv-LTPau7tQ';
    
    // Determine auth headers based on what's available
    let authHeaders = {};
    
    // Origin CA uses a special header
    if (originCAKey) {
        authHeaders = {
            'X-Auth-User-Service-Key': originCAKey
        };
        console.log('Using Origin CA Service Key for authentication');
    } else if (config.api_token) {
        // Try with API token
        authHeaders = {
            'Authorization': `Bearer ${config.api_token}`
        };
    } else if (config.email && config.api_key) {
        // Fall back to Global API Key
        authHeaders = {
            'X-Auth-Email': config.email,
            'X-Auth-Key': config.api_key
        };
    } else {
        console.error('❌ No valid Cloudflare credentials found.');
        console.error('   Please configure either:');
        console.error('   1. API Token with Origin CA permission');
        console.error('   2. Email + Global API Key');
        process.exit(1);
    }

    const options = {
        hostname: 'api.cloudflare.com',
        port: 443,
        path: '/client/v4/certificates',
        method: 'POST',
        headers: {
            ...authHeaders,
            'Content-Type': 'application/json',
            'Content-Length': requestData.length
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    
                    if (response.success) {
                        const certificate = response.result.certificate;
                        
                        // Create directory for Cloudflare certs
                        const cfDir = '/opt/proxy/certs/cloudflare';
                        if (!fs.existsSync(cfDir)) {
                            fs.mkdirSync(cfDir, { recursive: true });
                        }

                        // Save certificate and private key
                        fs.writeFileSync(path.join(cfDir, 'origin-cert.pem'), certificate);
                        fs.writeFileSync(path.join(cfDir, 'origin-key.pem'), privateKey);
                        
                        // Backup existing certificates
                        if (fs.existsSync('/opt/proxy/certs/cert.pem')) {
                            fs.copyFileSync('/opt/proxy/certs/cert.pem', '/opt/proxy/certs/cert.pem.backup');
                        }
                        if (fs.existsSync('/opt/proxy/certs/key.pem')) {
                            fs.copyFileSync('/opt/proxy/certs/key.pem', '/opt/proxy/certs/key.pem.backup');
                        }

                        // Install the Origin certificate
                        fs.copyFileSync(path.join(cfDir, 'origin-cert.pem'), '/opt/proxy/certs/cert.pem');
                        fs.copyFileSync(path.join(cfDir, 'origin-key.pem'), '/opt/proxy/certs/key.pem');

                        console.log('✅ Cloudflare Origin Certificate generated successfully!\n');
                        console.log('📁 Certificates saved to:', cfDir);
                        console.log('🔒 Certificate ID:', response.result.id);
                        console.log('📅 Expires:', new Date(response.result.expires_on).toLocaleDateString());
                        console.log('\n📋 Certificate covers these domains:');
                        domains.forEach(d => console.log(`   • ${d}`));
                        
                        console.log('\n⚠️  IMPORTANT NEXT STEPS:');
                        console.log('1. Restart the proxy: pkill -f "node src/server.js" && cd /opt/proxy && npm start');
                        console.log('2. In Cloudflare Dashboard for each domain:');
                        console.log('   • Go to SSL/TLS → Overview');
                        console.log('   • Set SSL mode to "Full (strict)"');
                        console.log('3. Create DNS A records pointing to your server IP (47.150.162.82)');
                        console.log('   • Enable proxy (orange cloud) for each record');
                        
                        resolve(true);
                    } else {
                        console.error('❌ Failed to generate certificate:', response.errors);
                        
                        if (response.errors?.[0]?.code === 1016) {
                            console.error('\n⚠️  Permission Error!');
                            console.error('Your API token needs "Origin CA" permission.');
                            console.error('\nTo fix this:');
                            console.error('1. Go to: https://dash.cloudflare.com/profile/api-tokens');
                            console.error('2. Create a new token or edit existing one');
                            console.error('3. Add permission: Origin CA → Origin Certificates → Create');
                            console.error('4. Update the token in admin panel: http://192.168.1.108:8081/cloudflare');
                            console.error('\nAlternatively, use your Global API Key instead of API Token');
                        }
                        
                        reject(new Error(response.errors?.[0]?.message || 'Unknown error'));
                    }
                } catch (error) {
                    console.error('❌ Error parsing response:', error);
                    console.error('Response:', data);
                    reject(error);
                }
            });
        });

        req.on('error', (error) => {
            console.error('❌ Request failed:', error);
            reject(error);
        });

        req.write(requestData);
        req.end();
    });
}

// For use when we have a proper API token/key, generate without CSR
async function generateOriginCertWithoutCSR() {
    const db = new Database();
    await db.initialize();
    const config = await db.get('SELECT * FROM cloudflare_config WHERE enabled = 1');
    
    if (!config) {
        console.error('❌ Cloudflare not configured');
        return false;
    }

    // Using the User API Key method which supports origin cert generation
    const axios = require('axios');
    
    try {
        // First, let's verify if we can use the Origin CA API
        // The Origin CA API uses a different authentication method
        console.log('📝 Attempting to use Origin CA API...');
        
        // Origin CA uses Service Key, not regular API tokens
        // We need to guide the user to get the Origin CA Key
        console.log('\n⚠️  Origin Certificates require special setup:');
        console.log('\n1. Using Origin CA Key (Recommended):');
        console.log('   • Go to: https://dash.cloudflare.com/?to=/:account/ssl-tls/origin-ca');
        console.log('   • Click "Create Certificate"');
        console.log('   • You\'ll see your Origin CA Key there');
        console.log('\n2. Using Global API Key:');
        console.log('   • Go to: https://dash.cloudflare.com/profile/api-tokens');
        console.log('   • View your Global API Key');
        console.log('   • Use with your email address');
        
        return false;
        
    } catch (error) {
        console.error('Error:', error.message);
        return false;
    }
}

// Run the appropriate method
if (require.main === module) {
    generateOriginCertificate()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Failed:', err);
            process.exit(1);
        });
}

module.exports = { generateOriginCertificate };