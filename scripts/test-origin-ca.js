#!/usr/bin/env node

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// Generate a private key
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
    },
    privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
    }
});

// Generate CSR
const { X509Certificate } = require('crypto');

// Create a simple CSR manually
function generateCSR(domains) {
    // This is a simplified CSR generation
    // In production, you'd use a proper library
    const subject = `/CN=${domains[0]}`;
    
    // For now, let's try without CSR
    return null;
}

async function testOriginCA() {
    const originCAKey = 'hloNJ6Mc_GvH2IXobxMmvAteh1aNAnv-LTPau7tQ';
    
    console.log('Testing Cloudflare Origin CA API...\n');
    
    const domains = [
        '*.rawrinc.com',
        'rawrinc.com'
    ];
    
    const requestData = JSON.stringify({
        hostnames: domains,
        requested_validity: 5475,
        request_type: 'origin-rsa'
    });
    
    // Try different authentication methods
    const authMethods = [
        {
            name: 'User Service Key',
            headers: {
                'X-Auth-User-Service-Key': originCAKey
            }
        },
        {
            name: 'Bearer Token',
            headers: {
                'Authorization': `Bearer ${originCAKey}`
            }
        },
        {
            name: 'API Key Header',
            headers: {
                'X-Auth-Key': originCAKey
            }
        }
    ];
    
    for (const method of authMethods) {
        console.log(`\nTrying ${method.name}...`);
        
        const options = {
            hostname: 'api.cloudflare.com',
            port: 443,
            path: '/client/v4/certificates',
            method: 'POST',
            headers: {
                ...method.headers,
                'Content-Type': 'application/json',
                'Content-Length': requestData.length
            }
        };
        
        try {
            const result = await new Promise((resolve, reject) => {
                const req = https.request(options, (res) => {
                    let data = '';
                    
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    
                    res.on('end', () => {
                        const response = JSON.parse(data);
                        if (response.success) {
                            console.log(`✅ Success with ${method.name}!`);
                            resolve(response);
                        } else {
                            console.log(`❌ Failed with ${method.name}:`, response.errors);
                            resolve(null);
                        }
                    });
                });
                
                req.on('error', (error) => {
                    console.error(`Error with ${method.name}:`, error.message);
                    resolve(null);
                });
                
                req.write(requestData);
                req.end();
            });
            
            if (result) {
                console.log('\n🎉 Successfully generated certificate!');
                
                // Save the certificate
                const cert = result.result.certificate;
                const key = result.result.private_key || privateKey;
                
                fs.writeFileSync('/opt/proxy/certs/cert.pem', cert);
                fs.writeFileSync('/opt/proxy/certs/key.pem', key);
                
                console.log('Certificate saved to /opt/proxy/certs/');
                console.log('Restart the proxy to use the new certificate.');
                return;
            }
        } catch (error) {
            console.error(`Exception with ${method.name}:`, error.message);
        }
    }
    
    console.log('\n❌ All authentication methods failed.');
    console.log('\nThis might be an Origin CA Key. Let me check if you need email too...');
    
    // The Origin CA key might need to be paired with email
    const Database = require('/opt/proxy/src/database/Database.js');
    const db = new Database();
    await db.initialize();
    const config = await db.get('SELECT * FROM cloudflare_config WHERE enabled = 1');
    
    if (!config.email) {
        console.log('\n⚠️  You might need to provide your Cloudflare account email.');
        console.log('Please update the configuration with your email address.');
    }
}

testOriginCA().catch(console.error);