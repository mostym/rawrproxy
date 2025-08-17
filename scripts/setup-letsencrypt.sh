#!/bin/bash

echo "Setting up Let's Encrypt certificates for RAWRProxy"

# Install certbot if not already installed
if ! command -v certbot &> /dev/null; then
    echo "Installing certbot..."
    apt-get update
    apt-get install -y certbot
fi

# Stop the proxy temporarily to free port 80
echo "Stopping proxy server temporarily..."
pkill -f "node src/server.js"
sleep 2

# Generate certificates for all domains
DOMAINS=(
    "pix.rawrinc.com"
    "proxy.rawrinc.com"
    "ha.25bc.com"
    "app.namrotsjh.com"
    "pan.causejesus.xyz"
)

# Use the first domain as primary
PRIMARY_DOMAIN="pix.rawrinc.com"

echo "Generating Let's Encrypt certificate for domains..."
DOMAIN_ARGS=""
for domain in "${DOMAINS[@]}"; do
    DOMAIN_ARGS="$DOMAIN_ARGS -d $domain"
done

# Generate certificate
certbot certonly --standalone $DOMAIN_ARGS \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --expand

if [ $? -eq 0 ]; then
    echo "Certificate generated successfully!"
    
    # Copy certificates to proxy directory
    cp /etc/letsencrypt/live/$PRIMARY_DOMAIN/fullchain.pem /opt/proxy/certs/cert.pem
    cp /etc/letsencrypt/live/$PRIMARY_DOMAIN/privkey.pem /opt/proxy/certs/key.pem
    
    echo "Certificates copied to /opt/proxy/certs/"
    
    # Restart proxy
    echo "Restarting proxy server..."
    cd /opt/proxy && npm start &
    
    echo "✅ Let's Encrypt SSL certificates installed successfully!"
else
    echo "❌ Failed to generate Let's Encrypt certificate"
    echo "Starting proxy with existing certificates..."
    cd /opt/proxy && npm start &
fi