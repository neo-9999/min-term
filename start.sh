#!/bin/sh
ln -sf /bin/bash /bin/sh
cat << 'EOF' >> /root/.bashrc
export PS1='\u@\h:\w\$ '
alias ls='ls --color=auto'
alias rm='rm -i'
EOF

if ! command -v htop >/dev/null 2>&1; then
  (
    export DEBIAN_FRONTEND=noninteractive
    apt-get update && apt-get install -y --no-install-recommends \
      vim nano curl wget unzip \
      procps net-tools iputils-ping iproute2 dnsutils lsof htop \
    && rm -rf /var/lib/apt/lists/*
  ) >/tmp/apt-install.log 2>&1 &
fi
exec node index.js
