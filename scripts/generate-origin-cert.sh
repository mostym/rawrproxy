#!/bin/bash

# Generate private key
openssl genrsa -out /opt/proxy/certs/cloudflare-key.pem 2048

# Create config file for CSR with all domains
cat > /opt/proxy/certs/csr.conf <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
ST = State
L = City
O = RAWRProxy
CN = *.rawrinc.com

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = *.25bc.com
DNS.2 = 25bc.com
DNS.3 = *.causejesus.xyz
DNS.4 = causejesus.xyz
DNS.5 = *.namrots.com
DNS.6 = namrots.com
DNS.7 = *.namrotsjh.com
DNS.8 = namrotsjh.com
DNS.9 = *.rawrcorp.com
DNS.10 = rawrcorp.com
DNS.11 = *.rawrinc.com
DNS.12 = rawrinc.com
DNS.13 = *.rawrpix.com
DNS.14 = rawrpix.com
DNS.15 = *.rawrtv.com
DNS.16 = rawrtv.com
DNS.17 = *.singspot.com
DNS.18 = singspot.com
DNS.19 = *.tektastic.com
DNS.20 = tektastic.com
DNS.21 = *.tivi.to
DNS.22 = tivi.to
EOF

# Generate CSR
openssl req -new -key /opt/proxy/certs/cloudflare-key.pem -out /opt/proxy/certs/cloudflare.csr -config /opt/proxy/certs/csr.conf

echo "CSR generated. Content:"
cat /opt/proxy/certs/cloudflare.csr