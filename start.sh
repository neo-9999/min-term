#!/bin/sh
ln -sf /bin/bash /bin/sh
cat << 'EOF' > /root/.bashrc
export PS1='\u@\h:\w\$ '
alias ls='ls --color=auto'
EOF
exec node index.js
