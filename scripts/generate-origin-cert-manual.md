# How to Generate Cloudflare Origin Certificate

## Method 1: Through Cloudflare Dashboard (Easiest)

1. **Go to Cloudflare Dashboard**
   - https://dash.cloudflare.com/
   - Select your domain (e.g., rawrinc.com)

2. **Navigate to SSL/TLS → Origin Server**
   - Click on "SSL/TLS" in the left sidebar
   - Click on "Origin Server" tab

3. **Create Certificate**
   - Click "Create Certificate" button
   - Select "Generate private key and CSR with Cloudflare"
   - Add hostnames:
     * `*.rawrinc.com`
     * `rawrinc.com`
     * (Add all your domains and wildcards)
   - Certificate validity: 15 years
   - Click "Create"

4. **Save the Certificate and Key**
   - Copy the Origin Certificate content
   - Copy the Private Key content
   - Save them as:
     * `/opt/proxy/certs/cert.pem` (certificate)
     * `/opt/proxy/certs/key.pem` (private key)

5. **Restart the proxy**
   ```bash
   pkill -f "node src/server.js"
   cd /opt/proxy && npm start
   ```

## Method 2: Using Global API Key

Since the Origin CA API key is hidden, you can use your Global API Key:

1. **Get your Global API Key**
   - Go to: https://dash.cloudflare.com/profile/api-tokens
   - Scroll down to "Global API Key"
   - Click "View"
   - Enter your password
   - Copy the key

2. **Update the configuration**
   - Add to your Cloudflare config:
     * Email: your-email@example.com
     * API Key: (the Global API Key you copied)

3. **Run the origin cert script**
   ```bash
   node /opt/proxy/scripts/cloudflare-origin-cert.js
   ```

## Method 3: Use Cloudflare Tunnel Instead

If Origin certificates are too complex, Cloudflare Tunnel is easier and doesn't need any certificates:

```bash
# Install cloudflared
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb

# Login to Cloudflare
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create rawrproxy

# Route your domains
cloudflared tunnel route dns rawrproxy pix.rawrinc.com
cloudflared tunnel route dns rawrproxy "*.rawrinc.com"
# ... repeat for other domains

# Run the tunnel
cloudflared tunnel run rawrproxy
```

## Why Full (Strict) Matters

- **Flexible**: Cloudflare ← HTTP → Your Server (Not secure between CF and you)
- **Full**: Cloudflare ← HTTPS (self-signed OK) → Your Server (Better)
- **Full (strict)**: Cloudflare ← HTTPS (valid cert) → Your Server (Best)

Origin certificates make "Full (strict)" possible without buying certificates.