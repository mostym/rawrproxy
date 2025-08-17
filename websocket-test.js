#!/usr/bin/env node

const Database = require('./src/database/Database');
const Logger = require('./src/utils/Logger');
const WebSocketTester = require('./src/utils/WebSocketTester');

async function testAllBackends() {
    const db = new Database();
    const logger = new Logger();
    const tester = new WebSocketTester(logger);
    
    await db.initialize();
    
    console.log('\n===========================================');
    console.log('     WEBSOCKET BACKEND TESTING REPORT     ');
    console.log('===========================================\n');
    
    const backends = await db.all(`
        SELECT b.*, db.domainId, db.subdomainId, d.domain, s.subdomain
        FROM backends b
        LEFT JOIN domain_backends db ON b.id = db.backendId
        LEFT JOIN domains d ON db.domainId = d.id
        LEFT JOIN subdomains s ON db.subdomainId = s.id
        WHERE b.active = 1
        ORDER BY d.domain, s.subdomain, b.name
    `);
    
    const results = [];
    
    for (const backend of backends) {
        const hostname = backend.subdomain ? 
            `${backend.subdomain}.${backend.domain}` : 
            backend.domain || backend.name;
            
        console.log(`Testing ${hostname} (${backend.url})...`);
        
        const result = await tester.testBackend(backend.url);
        
        if (result.supportsWebSocket) {
            console.log(`  ✅ WebSocket SUPPORTED`);
            console.log(`     Endpoints: ${result.workingEndpoints.map(e => e.endpoint).join(', ')}`);
            
            // Update database
            const best = await tester.findBestEndpoint(backend.url);
            if (best) {
                await db.run(`
                    UPDATE backends 
                    SET ws_supported = 1, ws_endpoint = ?
                    WHERE id = ?
                `, [best.endpoint, backend.id]);
            }
        } else {
            console.log(`  ❌ No WebSocket support`);
            await db.run(`
                UPDATE backends 
                SET ws_supported = 0, ws_endpoint = NULL
                WHERE id = ?
            `, [backend.id]);
        }
        
        results.push({
            hostname,
            backend: backend.name,
            url: backend.url,
            wsSupported: result.supportsWebSocket,
            endpoints: result.workingEndpoints.map(e => e.endpoint)
        });
        
        console.log('');
    }
    
    // Summary
    console.log('\n===========================================');
    console.log('                 SUMMARY                   ');
    console.log('===========================================\n');
    
    const wsEnabled = results.filter(r => r.wsSupported);
    const wsDisabled = results.filter(r => !r.wsSupported);
    
    console.log(`Total backends tested: ${results.length}`);
    console.log(`WebSocket enabled: ${wsEnabled.length}`);
    console.log(`WebSocket disabled: ${wsDisabled.length}`);
    
    if (wsEnabled.length > 0) {
        console.log('\n✅ Backends with WebSocket support:');
        wsEnabled.forEach(r => {
            console.log(`   - ${r.hostname} (${r.url})`);
            console.log(`     Endpoints: ${r.endpoints.join(', ')}`);
        });
    }
    
    if (wsDisabled.length > 0) {
        console.log('\n❌ Backends WITHOUT WebSocket support:');
        wsDisabled.forEach(r => {
            console.log(`   - ${r.hostname} (${r.url})`);
        });
    }
    
    console.log('\n===========================================\n');
    
    process.exit(0);
}

testAllBackends().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});