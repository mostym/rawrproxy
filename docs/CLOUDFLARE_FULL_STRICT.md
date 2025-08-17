# Cloudflare Full (Strict) SSL Setup Guide

## Current Situation
- Your domains are active on Cloudflare with SSL
- RAWRProxy is using a self-signed certificate (localhost)
- You want Full (strict) mode for maximum security

## Two Options for Full (Strict) Mode

### Option 1: Cloudflare Origin Certificate (Recommended)
**Pros:**
- Valid for 15 years
- No renewal needed
- Trusted by Cloudflare
- Free

**Requirements:**
You need ONE of these:
1. **Origin CA API Key** (different from regular API token)
   - Go to: https://dash.cloudflare.com/
   - Select your account
   - SSL/TLS → Origin Server
   - Click "Create Certificate" 
   - You'll see "Origin CA Key" - copy this

2. **Global API Key** (not recommended but works)
   - Go to: https://dash.cloudflare.com/profile/api-tokens
   - View Global API Key
   - Use with your email

3. **API Token with Origin CA permission**
   - Create new token at: https://dash.cloudflare.com/profile/api-tokens
   - Custom token with: Origin CA → Origin Certificates → Create

### Option 2: Cloudflare Tunnel
**Pros:**
- No certificates needed at all
- No port forwarding needed
- Works behind CGNAT
- Built-in security

**Setup:**
```bash
# Run the tunnel setup script
bash /opt/proxy/scripts/setup-cloudflare-tunnel.sh
```

## Quick Setup for Origin Certificate

### Step 1: Get the Right Credentials

The API token you currently have (`jRW6hdYvpUMsRjVo-GDkkdMAAMpJ9RyWPWQ8I8jU`) doesn't have Origin CA permission.

**Easiest Method - Get Origin CA Key:**
1. Go to https://dash.cloudflare.com/
2. Select your account
3. Navigate to SSL/TLS → Origin Server
4. Click "Create Certificate" button
5. You'll see "Origin CA Key" field - copy this key

### Step 2: Update Configuration

Edit `/opt/proxy/.env` and add:
```
CLOUDFLARE_ORIGIN_CA_KEY=<your_origin_ca_key_here>
```

### Step 3: Generate Origin Certificate

```bash
node /opt/proxy/scripts/cloudflare-origin-cert.js
```

### Step 4: Configure Cloudflare SSL Mode

For EACH domain in Cloudflare dashboard:
1. Go to SSL/TLS → Overview
2. Select "Full (strict)"
3. Ensure DNS records are proxied (orange cloud)

## Current Domain Status

Your domains with Cloudflare SSL active:
- ✅ 25bc.com
- ✅ causejesus.xyz
- ✅ namrots.com
- ✅ namrotsjh.com
- ✅ rawrcorp.com
- ✅ rawrinc.com
- ✅ rawrpix.com
- ✅ rawrtv.com
- ✅ singspot.com
- ✅ tektastic.com
- ✅ tivi.to

## Verification

After setup, you should see:
1. No more browser SSL warnings
2. Padlock shows "Connection is secure"
3. Certificate issued by "Cloudflare Inc ECC CA-3"
4. Full end-to-end encryption

## Troubleshooting

### "ERR_CERT_AUTHORITY_INVALID"
- Origin certificate not installed correctly
- Or Cloudflare SSL mode not set to Full (strict)

### API Permission Errors
- You're using wrong API credentials
- Get the Origin CA Key as shown above

### Services Still Not Working
- Check if backend is actually running
- Verify correct ports in configuration
- Check firewall rules

## Architecture

```
User Browser → Cloudflare (Valid SSL) → Your Server (Origin Cert) → Backend Service
     ↑              ↑                          ↑                         ↑
   HTTPS      Cloudflare SSL            Origin Certificate         HTTP/HTTPS
              (Let's Encrypt)            (15 years valid)          (Internal)
```

This provides full end-to-end encryption with valid certificates at every step.