#!/bin/bash

echo "==================================="
echo "RAWRProxy Cloudflare Setup"
echo "==================================="
echo ""
echo "This script will help you configure Cloudflare integration for RAWRProxy."
echo ""
echo "You'll need:"
echo "1. A Cloudflare API Token with permissions for:"
echo "   - Zone:DNS:Edit"
echo "   - Zone:Zone:Read"
echo "   - Zone:SSL and Certificates:Edit"
echo ""
echo "To create an API token:"
echo "1. Go to https://dash.cloudflare.com/profile/api-tokens"
echo "2. Click 'Create Token'"
echo "3. Use 'Edit zone DNS' template or create custom token"
echo ""
read -p "Enter your Cloudflare API Token: " CF_TOKEN

if [ -z "$CF_TOKEN" ]; then
    echo "Error: API Token is required"
    exit 1
fi

# Update .env file
sed -i "s/CLOUDFLARE_API_TOKEN=.*/CLOUDFLARE_API_TOKEN=$CF_TOKEN/" /opt/proxy/.env

echo ""
echo "Configuration updated!"
echo ""
echo "Available domains in your Cloudflare account:"
echo "- 25bc.com"
echo "- causejesus.xyz"
echo "- namrots.com"
echo "- namrotsjh.com"
echo "- rawrcorp.com"
echo "- rawrinc.com"
echo "- rawrpix.com"
echo "- rawrtv.com"
echo "- singspot.com"
echo "- tektastic.com"
echo "- tivi.to"
echo ""
echo "Restarting RAWRProxy to apply changes..."
cd /opt/proxy
npm restart

echo ""
echo "Setup complete! RAWRProxy will now:"
echo "1. Use Cloudflare for SSL certificates"
echo "2. Automatically create DNS records for new services"
echo "3. Proxy traffic through Cloudflare for DDoS protection"