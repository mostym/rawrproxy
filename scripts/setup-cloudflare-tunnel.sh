#!/bin/bash

echo "==================================="
echo "Cloudflare Tunnel Setup for RAWRProxy"
echo "==================================="
echo ""

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "Installing cloudflared..."
    
    # Download and install cloudflared
    wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    dpkg -i cloudflared-linux-amd64.deb
    rm cloudflared-linux-amd64.deb
    
    echo "✅ cloudflared installed"
fi

echo ""
echo "To set up a Cloudflare Tunnel:"
echo ""
echo "1. Authenticate with Cloudflare:"
echo "   cloudflared tunnel login"
echo ""
echo "2. Create a tunnel:"
echo "   cloudflared tunnel create rawr-proxy"
echo ""
echo "3. Create config file at /etc/cloudflared/config.yml:"
echo ""
cat << 'EOF'
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json

ingress:
  # Route each domain to the proxy
  - hostname: pix.rawrinc.com
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.rawrinc.com"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.25bc.com"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.causejesus.xyz"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.namrots.com"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.namrotsjh.com"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.rawrcorp.com"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.rawrpix.com"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.rawrtv.com"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.singspot.com"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.tektastic.com"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  - hostname: "*.tivi.to"
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
  # Catch-all
  - service: http_status:404
EOF

echo ""
echo "4. Route DNS to the tunnel (for each domain):"
echo "   cloudflared tunnel route dns <TUNNEL_NAME> <DOMAIN>"
echo ""
echo "5. Run the tunnel:"
echo "   cloudflared tunnel run rawr-proxy"
echo ""
echo "6. Install as a service:"
echo "   cloudflared service install"
echo "   systemctl start cloudflared"
echo ""
echo "Benefits of Cloudflare Tunnel:"
echo "✅ No need for SSL certificates"
echo "✅ No need to open ports on firewall"
echo "✅ Built-in DDoS protection"
echo "✅ Works behind CGNAT/Dynamic IP"
echo "✅ Zero Trust security"