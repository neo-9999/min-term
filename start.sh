#!/bin/sh
#[ -f /bin/bash ] && { rm -f /bin/sh;ln -sf /bin/bash /bin/sh; }
cat << 'EOF' > ~/.bash_profile
export PS1='\w\$ '
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

BUSYBOX_SRC="$HOME/bin/busybox"
LOCAL_BIN="$HOME/local/bin"

# 仅在 ~/local/bin 目录不存在且源文件存在时，执行初始化操作
if [ ! -d "$LOCAL_BIN" ] && [ -f "$BUSYBOX_SRC" ]; then
  mkdir -p "$LOCAL_BIN"
  cp "$BUSYBOX_SRC" "$LOCAL_BIN/busybox"
  chmod +x "$LOCAL_BIN/busybox"

  # 先检测当前环境能否执行 busybox（防止在 WASI 沙箱里报错）
  if "$LOCAL_BIN/busybox" --list >/dev/null 2>&1; then
    "$LOCAL_BIN/busybox" --install -s "$LOCAL_BIN" 2>/dev/null || \
    for cmd in $("$LOCAL_BIN/busybox" --list); do
      ln -sf "$LOCAL_BIN/busybox" "$LOCAL_BIN/$cmd"
    done
  else
    echo "[Warning] busybox is not executable in this environment, skipping symlinks."
  fi
fi

# 2. 只要目录存在，就确保当前启动进程（以及后续的 node 和 /term）继承 PATH
if [ -d "$LOCAL_BIN" ]; then
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) ;;
    *) export PATH="$PATH:$LOCAL_BIN" ;;
  esac
fi

exec node index.js
