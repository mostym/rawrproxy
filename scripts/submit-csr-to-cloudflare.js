#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Database = require('/opt/proxy/src/database/Database.js');

async function submitCSRToCloudflare() {
    // Get API token from database
    const db = new Database();
    await db.initialize();
    const config = await db.get('SELECT * FROM cloudflare_config WHERE enabled = 1');
    
    if (!config || !config.api_token) {
        console.error('Error: Cloudflare API token not configured in database');
        process.exit(1);
    }
    
    const apiToken = config.api_token;
    
    // Read the CSR
    const csr = fs.readFileSync('/opt/proxy/certs/cloudflare.csr', 'utf8');
    
    console.log('Submitting CSR to Cloudflare for Origin Certificate...');
    
    try {
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
        
        const response = await axios.post(
            'https://api.cloudflare.com/client/v4/certificates',
            {
                hostnames: domains,
                requested_validity: 5475, // 15 years
                request_type: 'origin-rsa',
                csr: csr
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (response.data.success) {
            const cert = response.data.result.certificate;
            
            // Create cloudflare certs directory
            const certsDir = '/opt/proxy/certs/cloudflare';
            if (!fs.existsSync(certsDir)) {
                fs.mkdirSync(certsDir, { recursive: true });
            }
            
            // Save certificate (we already have the key from CSR generation)
            fs.writeFileSync(path.join(certsDir, 'cert.pem'), cert);
            
            // Copy the key we generated
            fs.copyFileSync('/opt/proxy/certs/cloudflare-key.pem', path.join(certsDir, 'key.pem'));
            
            // Backup old certificates
            if (fs.existsSync('/opt/proxy/certs/cert.pem')) {
                fs.renameSync('/opt/proxy/certs/cert.pem', '/opt/proxy/certs/cert.pem.bak');
            }
            if (fs.existsSync('/opt/proxy/certs/key.pem')) {
                fs.renameSync('/opt/proxy/certs/key.pem', '/opt/proxy/certs/key.pem.bak');
            }
            
            // Copy Cloudflare certificates to main location
            fs.copyFileSync(path.join(certsDir, 'cert.pem'), '/opt/proxy/certs/cert.pem');
            fs.copyFileSync(path.join(certsDir, 'key.pem'), '/opt/proxy/certs/key.pem');
            
            console.log('✅ Cloudflare Origin Certificate installed successfully!');
            console.log('📁 Certificates saved to:', certsDir);
            console.log('🔗 Certificates copied to /opt/proxy/certs/');
            console.log('\nCertificate includes the following domains:');
            domains.forEach(d => console.log(`  - ${d}`));
            console.log('\n⚠️  IMPORTANT: Now restart the proxy to use the new certificates:');
            console.log('   pkill -f "node src/server.js" && cd /opt/proxy && npm start');
            
            return true;
        } else {
            console.error('Failed to generate certificate:', response.data.errors);
            return false;
        }
    } catch (error) {
        console.error('Error generating certificate:', error.response?.data || error.message);
        return false;
    }
}

// Run the script
submitCSRToCloudflare();