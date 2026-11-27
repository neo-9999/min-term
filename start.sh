#!/bin/sh
#[ -f /bin/bash ] && { rm -f /bin/sh;ln -sf /bin/bash /bin/sh; }
cat << 'EOF' > ~/.bashrc
export PS1='\u@\h:\w\$ '
alias ls='ls --color=auto'
alias rm='rm -i'
EOF

if ! command -v htop >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ]; then
    if command -v apt-get >/dev/null 2>&1; then
      (
        export DEBIAN_FRONTEND=noninteractive
        apt-get update && apt-get install -y --no-install-recommends \
          vim nano curl wget unzip \
          procps net-tools iputils-ping iproute2 dnsutils lsof htop \
        && rm -rf /var/lib/apt/lists/*
      ) >/tmp/apt-install.log 2>&1 &
    else
      echo "Not apt-get."
    fi
  else
    echo "Not running as root (uid=$(id -u)); no root privileges."
  fi 
fi
exec node index.js
