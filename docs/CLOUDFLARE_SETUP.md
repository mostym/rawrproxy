# Cloudflare Integration Setup for RAWRProxy

## Your Cloudflare Domains
- 25bc.com (SSL Active)
- causejesus.xyz (SSL Active)
- namrots.com (SSL Active)
- namrotsjh.com (SSL Active)
- rawrcorp.com (SSL Active)
- rawrinc.com (SSL Active)
- rawrpix.com (SSL Active)
- rawrtv.com (SSL Active)
- singspot.com (SSL Active)
- tektastic.com (SSL Active)
- tivi.to (SSL Active)

## Quick Setup

### Step 1: Create Cloudflare API Token
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use "Edit zone DNS" template or create custom token with:
   - Zone:DNS:Edit
   - Zone:Zone:Read
   - Zone:SSL and Certificates:Edit
   - Include all your zones

### Step 2: Configure RAWRProxy
```bash
# Edit the .env file
nano /opt/proxy/.env

# Add your API token:
CLOUDFLARE_API_TOKEN=your_token_here
```

### Step 3: Restart RAWRProxy
```bash
cd /opt/proxy
npm restart
```

## Benefits Once Configured

1. **Valid SSL Certificates**: No more browser warnings
2. **Automatic DNS Management**: Services automatically get DNS records
3. **DDoS Protection**: Traffic proxied through Cloudflare
4. **Global CDN**: Faster access worldwide
5. **Origin Certificates**: Secure connection between Cloudflare and your proxy

## Current Service Mappings

Based on your Proxmox VMs/Containers:
- pix.rawrinc.com → 192.168.1.120:2283 (Immich)
- ha.25bc.com → 192.168.1.110:8123 (Home Assistant)
- app.namrotsjh.com → 192.168.1.105:80
- pan.causejesus.xyz → 192.168.1.113:80
- onlyoffice.rawrinc.com → 192.168.1.112:8080

## SSL Mode Recommendations

For maximum security, configure Cloudflare SSL mode to "Full (strict)" after Origin certificates are installed:

1. Go to your domain in Cloudflare dashboard
2. SSL/TLS → Overview
3. Select "Full (strict)"
4. This ensures end-to-end encryption

## Troubleshooting

### SSL Certificate Warnings
- Temporary: Click "Advanced" and proceed to site
- Permanent: Configure Cloudflare API token for valid certificates

### Services Not Loading
- Check if VM/container is running in Proxmox
- Verify correct port in backend configuration
- Check firewall rules allow traffic

### API/WebSocket Issues
- Ensure WEBSOCKET_ENABLED=true in .env
- Check browser console for specific errors
- Verify backend service is responding

## Admin Panel Access

Access the admin panel at:
- http://192.168.1.108:8081
- https://proxy.rawrinc.com:8081 (once DNS configured)

From here you can:
- Manage domains and subdomains
- Configure backends
- View logs
- Test Cloudflare integration
- Sync with Proxmox