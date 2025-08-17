#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');
const { execSync } = require('child_process');

async function generateOriginCertWithCSR() {
    const apiToken = 'hloNJ6Mc_GvH2IXobxMmvAteh1aNAnv-LTPau7tQ';
    
    console.log('🔐 Generating Cloudflare Origin Certificate with CSR...\n');
    
    // Step 1: Generate private key and CSR using OpenSSL
    console.log('Generating private key and CSR...');
    
    try {
        // Generate private key
        execSync('openssl genrsa -out /opt/proxy/certs/origin-key.pem 2048');
        
        // Create CSR config
        const csrConfig = `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
ST = State
L = City
O = RAWRProxy
CN = rawrinc.com

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = *.rawrinc.com
DNS.2 = rawrinc.com
DNS.3 = *.rawrpix.com
DNS.4 = rawrpix.com
DNS.5 = *.25bc.com
DNS.6 = 25bc.com
`;
        
        fs.writeFileSync('/opt/proxy/certs/csr.conf', csrConfig);
        
        // Generate CSR
        execSync('openssl req -new -key /opt/proxy/certs/origin-key.pem -out /opt/proxy/certs/origin.csr -config /opt/proxy/certs/csr.conf');
        
        // Read the CSR
        const csr = fs.readFileSync('/opt/proxy/certs/origin.csr', 'utf8');
        
        console.log('CSR generated successfully');
        
        // Step 2: Submit to Cloudflare
        console.log('\nSubmitting to Cloudflare...');
        
        const domains = [
            '*.rawrinc.com', 'rawrinc.com',
            '*.rawrpix.com', 'rawrpix.com',
            '*.rawrcorp.com', 'rawrcorp.com',
            '*.rawrtv.com', 'rawrtv.com',
            '*.25bc.com', '25bc.com',
            '*.causejesus.xyz', 'causejesus.xyz',
            '*.namrots.com', 'namrots.com',
            '*.namrotsjh.com', 'namrotsjh.com',
            '*.singspot.com', 'singspot.com',
            '*.tektastic.com', 'tektastic.com',
            '*.tivi.to', 'tivi.to'
        ];
        
        const requestData = JSON.stringify({
            hostnames: domains,
            requested_validity: 5475, // 15 years
            request_type: 'origin-rsa',
            csr: csr
        });
        
        const options = {
            hostname: 'api.cloudflare.com',
            port: 443,
            path: '/client/v4/certificates',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
                'Content-Length': requestData.length
            }
        };
        
        const result = await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        resolve(response);
                    } catch (e) {
                        reject(new Error('Invalid response: ' + data));
                    }
                });
            });
            
            req.on('error', reject);
            req.write(requestData);
            req.end();
        });
        
        if (result.success) {
            console.log('✅ Certificate generated successfully!');
            
            // Save the certificate
            const cert = result.result.certificate;
            fs.writeFileSync('/opt/proxy/certs/origin-cert.pem', cert);
            
            // Copy to main location
            fs.copyFileSync('/opt/proxy/certs/origin-cert.pem', '/opt/proxy/certs/cert.pem');
            fs.copyFileSync('/opt/proxy/certs/origin-key.pem', '/opt/proxy/certs/key.pem');
            
            console.log('\n📁 Certificate saved to /opt/proxy/certs/');
            console.log('🆔 Certificate ID:', result.result.id);
            console.log('📅 Expires:', new Date(result.result.expires_on).toLocaleDateString());
            
            console.log('\n✨ Certificate covers these domains:');
            domains.forEach(d => console.log(`   • ${d}`));
            
            console.log('\n⚠️  IMPORTANT: Now restart the proxy:');
            console.log('   pkill -f "node src/server.js" && cd /opt/proxy && npm start');
            
            console.log('\n🔧 Also set SSL mode to "Full (strict)" in Cloudflare for each domain');
            
        } else {
            console.error('❌ Failed to generate certificate:', result.errors);
            
            if (result.errors?.[0]?.code === 1016) {
                console.log('\n⚠️  This API token needs more permissions.');
                console.log('Create a new token at: https://dash.cloudflare.com/profile/api-tokens');
                console.log('With these permissions:');
                console.log('  • Zone:SSL and Certificates:Edit');
                console.log('  • Zone:Zone:Read');
                console.log('  • User:User Details:Read');
                console.log('\nOr use your Global API Key instead.');
            }
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

generateOriginCertWithCSR().catch(console.error);