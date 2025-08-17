#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const Database = require('/opt/proxy/src/database/Database.js');

class CloudflareDNS01 {
    constructor(apiToken) {
        this.apiToken = apiToken;
        this.apiBase = 'https://api.cloudflare.com/client/v4';
    }

    async getZoneId(domain) {
        // Find the zone for this domain
        const baseDomain = domain.split('.').slice(-2).join('.');
        
        try {
            const response = await axios.get(`${this.apiBase}/zones?name=${baseDomain}`, {
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.data.success && response.data.result.length > 0) {
                return response.data.result[0].id;
            }
            throw new Error(`Zone not found for ${baseDomain}`);
        } catch (error) {
            console.error(`Failed to get zone ID for ${domain}:`, error.message);
            throw error;
        }
    }

    async addTXTRecord(domain, value) {
        const zoneId = await this.getZoneId(domain);
        const recordName = `_acme-challenge.${domain}`;
        
        console.log(`Adding TXT record for ${recordName} with value: ${value}`);
        
        try {
            // First, check if record exists and delete it
            const existingRecords = await axios.get(
                `${this.apiBase}/zones/${zoneId}/dns_records?type=TXT&name=${recordName}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            // Delete existing records
            if (existingRecords.data.result.length > 0) {
                for (const record of existingRecords.data.result) {
                    await axios.delete(
                        `${this.apiBase}/zones/${zoneId}/dns_records/${record.id}`,
                        {
                            headers: {
                                'Authorization': `Bearer ${this.apiToken}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                }
            }
            
            // Add new record
            const response = await axios.post(
                `${this.apiBase}/zones/${zoneId}/dns_records`,
                {
                    type: 'TXT',
                    name: recordName,
                    content: value,
                    ttl: 120
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (response.data.success) {
                console.log(`✅ TXT record added for ${recordName}`);
                return true;
            }
            throw new Error(response.data.errors?.[0]?.message || 'Failed to add TXT record');
        } catch (error) {
            console.error(`Failed to add TXT record:`, error.message);
            throw error;
        }
    }

    async removeTXTRecord(domain) {
        const zoneId = await this.getZoneId(domain);
        const recordName = `_acme-challenge.${domain}`;
        
        console.log(`Removing TXT record for ${recordName}`);
        
        try {
            const existingRecords = await axios.get(
                `${this.apiBase}/zones/${zoneId}/dns_records?type=TXT&name=${recordName}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (existingRecords.data.result.length > 0) {
                for (const record of existingRecords.data.result) {
                    await axios.delete(
                        `${this.apiBase}/zones/${zoneId}/dns_records/${record.id}`,
                        {
                            headers: {
                                'Authorization': `Bearer ${this.apiToken}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    console.log(`✅ TXT record removed for ${recordName}`);
                }
            }
            return true;
        } catch (error) {
            console.error(`Failed to remove TXT record:`, error.message);
            return false;
        }
    }
}

async function getCertificateWithDNS01() {
    // Get API token from database
    const db = new Database();
    await db.initialize();
    const config = await db.get('SELECT * FROM cloudflare_config WHERE enabled = 1');
    
    if (!config || !config.api_token) {
        console.error('Error: Cloudflare API token not configured');
        process.exit(1);
    }
    
    const cfDNS = new CloudflareDNS01(config.api_token);
    
    // Domains to get certificates for
    const domains = [
        'rawrinc.com',
        'rawrpix.com',
        'rawrcorp.com',
        'rawrtv.com',
        '25bc.com',
        'causejesus.xyz',
        'namrots.com',
        'namrotsjh.com',
        'singspot.com',
        'tektastic.com',
        'tivi.to'
    ];
    
    console.log('🔐 Starting Let\'s Encrypt certificate generation with DNS-01 challenge...\n');
    
    for (const domain of domains) {
        console.log(`\n📋 Processing domain: ${domain}`);
        
        try {
            // Use certbot in manual mode with hooks
            const certbotCmd = `certbot certonly \
                --manual \
                --preferred-challenges dns \
                --manual-auth-hook "node /opt/proxy/scripts/cloudflare-auth-hook.js" \
                --manual-cleanup-hook "node /opt/proxy/scripts/cloudflare-cleanup-hook.js" \
                -d "${domain}" \
                -d "*.${domain}" \
                --non-interactive \
                --agree-tos \
                --register-unsafely-without-email \
                --expand`;
            
            console.log(`Running: ${certbotCmd}`);
            
            // Create the auth and cleanup hook scripts
            await createHookScripts(config.api_token);
            
            const { stdout, stderr } = await execPromise(certbotCmd);
            console.log(stdout);
            if (stderr) console.error(stderr);
            
            // Copy the first domain's certificate to be used by the proxy
            if (domain === 'rawrinc.com') {
                console.log('\n📁 Copying certificates to proxy directory...');
                await execPromise(`cp /etc/letsencrypt/live/${domain}/fullchain.pem /opt/proxy/certs/cert.pem`);
                await execPromise(`cp /etc/letsencrypt/live/${domain}/privkey.pem /opt/proxy/certs/key.pem`);
                console.log('✅ Certificates copied successfully!');
            }
            
        } catch (error) {
            console.error(`❌ Failed to get certificate for ${domain}:`, error.message);
        }
    }
    
    console.log('\n🎉 Certificate generation complete!');
    console.log('⚠️  Restart the proxy to use the new certificates:');
    console.log('   pkill -f "node src/server.js" && cd /opt/proxy && npm start');
}

async function createHookScripts(apiToken) {
    // Create auth hook script
    const authHookContent = `#!/usr/bin/env node
const axios = require('axios');

const domain = process.env.CERTBOT_DOMAIN;
const validation = process.env.CERTBOT_VALIDATION;
const apiToken = '${apiToken}';

async function addRecord() {
    const baseDomain = domain.split('.').slice(-2).join('.');
    
    // Get zone ID
    const zonesResp = await axios.get(\`https://api.cloudflare.com/client/v4/zones?name=\${baseDomain}\`, {
        headers: { 'Authorization': \`Bearer \${apiToken}\` }
    });
    
    const zoneId = zonesResp.data.result[0].id;
    
    // Add TXT record
    await axios.post(
        \`https://api.cloudflare.com/client/v4/zones/\${zoneId}/dns_records\`,
        {
            type: 'TXT',
            name: \`_acme-challenge.\${domain}\`,
            content: validation,
            ttl: 120
        },
        {
            headers: { 'Authorization': \`Bearer \${apiToken}\` }
        }
    );
    
    // Wait for DNS propagation
    await new Promise(resolve => setTimeout(resolve, 20000));
}

addRecord().catch(console.error);
`;

    const cleanupHookContent = `#!/usr/bin/env node
const axios = require('axios');

const domain = process.env.CERTBOT_DOMAIN;
const apiToken = '${apiToken}';

async function removeRecord() {
    const baseDomain = domain.split('.').slice(-2).join('.');
    
    // Get zone ID
    const zonesResp = await axios.get(\`https://api.cloudflare.com/client/v4/zones?name=\${baseDomain}\`, {
        headers: { 'Authorization': \`Bearer \${apiToken}\` }
    });
    
    const zoneId = zonesResp.data.result[0].id;
    const recordName = \`_acme-challenge.\${domain}\`;
    
    // Get existing records
    const recordsResp = await axios.get(
        \`https://api.cloudflare.com/client/v4/zones/\${zoneId}/dns_records?type=TXT&name=\${recordName}\`,
        {
            headers: { 'Authorization': \`Bearer \${apiToken}\` }
        }
    );
    
    // Delete records
    for (const record of recordsResp.data.result) {
        await axios.delete(
            \`https://api.cloudflare.com/client/v4/zones/\${zoneId}/dns_records/\${record.id}\`,
            {
                headers: { 'Authorization': \`Bearer \${apiToken}\` }
            }
        );
    }
}

removeRecord().catch(console.error);
`;

    fs.writeFileSync('/opt/proxy/scripts/cloudflare-auth-hook.js', authHookContent);
    fs.writeFileSync('/opt/proxy/scripts/cloudflare-cleanup-hook.js', cleanupHookContent);
    fs.chmodSync('/opt/proxy/scripts/cloudflare-auth-hook.js', 0o755);
    fs.chmodSync('/opt/proxy/scripts/cloudflare-cleanup-hook.js', 0o755);
}

// Run the script
getCertificateWithDNS01().catch(console.error);