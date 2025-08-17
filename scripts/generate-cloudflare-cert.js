#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Database = require('/opt/proxy/src/database/Database.js');

async function generateCloudflareOriginCert() {
    // Get API token from database
    const db = new Database();
    await db.initialize();
    const config = await db.get('SELECT * FROM cloudflare_config WHERE enabled = 1');
    
    if (!config || !config.api_token) {
        console.error('Error: Cloudflare API token not configured in database');
        process.exit(1);
    }
    
    const apiToken = config.api_token;
    
    console.log('Generating Cloudflare Origin Certificate...');
    
    try {
        // Get list of domains to include in certificate
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
                request_type: 'origin-rsa'
                // Omit csr to let Cloudflare generate the private key
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
            const key = response.data.result.private_key;
            
            // Create cloudflare certs directory
            const certsDir = '/opt/proxy/certs/cloudflare';
            if (!fs.existsSync(certsDir)) {
                fs.mkdirSync(certsDir, { recursive: true });
            }
            
            // Save certificate and key
            fs.writeFileSync(path.join(certsDir, 'cert.pem'), cert);
            fs.writeFileSync(path.join(certsDir, 'key.pem'), key);
            
            // Backup old certificates
            if (fs.existsSync('/opt/proxy/certs/cert.pem')) {
                fs.renameSync('/opt/proxy/certs/cert.pem', '/opt/proxy/certs/cert.pem.bak');
            }
            if (fs.existsSync('/opt/proxy/certs/key.pem')) {
                fs.renameSync('/opt/proxy/certs/key.pem', '/opt/proxy/certs/key.pem.bak');
            }
            
            // Create symlinks to Cloudflare certificates
            fs.symlinkSync(path.join(certsDir, 'cert.pem'), '/opt/proxy/certs/cert.pem');
            fs.symlinkSync(path.join(certsDir, 'key.pem'), '/opt/proxy/certs/key.pem');
            
            console.log('✅ Cloudflare Origin Certificate generated successfully!');
            console.log('📁 Certificates saved to:', certsDir);
            console.log('🔗 Symlinks created in /opt/proxy/certs/');
            console.log('\nCertificate includes the following domains:');
            domains.forEach(d => console.log(`  - ${d}`));
            console.log('\n⚠️  IMPORTANT: You need to restart the proxy for changes to take effect:');
            console.log('   cd /opt/proxy && npm restart');
            
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
generateCloudflareOriginCert();