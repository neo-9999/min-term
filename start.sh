#!/bin/sh

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_BIN="$HOME/local/bin"

echo "[start.sh] Starting... uid=$(id -u) app_dir=$APP_DIR home=$HOME"

# 1. 初始化 Shell 配置（直接包含 PATH，避免重启覆盖丢失）
cat << 'EOF' > "$HOME/.bash_profile"
export PS1='\w\$ '
export PATH="$PATH:$HOME/local/bin"
alias ls='ls --color=auto'
alias rm='rm -i'
EOF

# 2. 按需后台安装常用工具（仅 root 且支持 apt-get 时执行）
if command -v htop >/dev/null 2>&1; then
  echo "[start.sh] htop already installed, skipping apt-get."
elif [ "$(id -u)" -eq 0 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "[start.sh] Running apt-get install in background (log: /tmp/apt-install.log)..."
    (
      export DEBIAN_FRONTEND=noninteractive
      apt-get update && apt-get install -y --no-install-recommends \
        vim nano curl wget unzip \
        procps net-tools iputils-ping iproute2 dnsutils lsof htop \
      && rm -rf /var/lib/apt/lists/*
    ) >/tmp/apt-install.log 2>&1 &
  else
    echo "[start.sh] apt-get not found, skipping package installation."
  fi
else
  echo "[start.sh] Not running as root (uid=$(id -u)); skipping apt-get."
fi

# 3. 优先从项目目录寻找 bin/busybox，找不到再回退到 $HOME/bin/busybox
BUSYBOX_SRC=""
if [ -f "$APP_DIR/bin/busybox" ]; then
  BUSYBOX_SRC="$APP_DIR/bin/busybox"
elif [ -f "$HOME/bin/busybox" ]; then
  BUSYBOX_SRC="$HOME/bin/busybox"
fi

if [ -d "$LOCAL_BIN" ]; then
  echo "[start.sh] $LOCAL_BIN already exists, skipping busybox setup."
elif [ -n "$BUSYBOX_SRC" ]; then
  echo "[start.sh] Found busybox at $BUSYBOX_SRC, initializing $LOCAL_BIN..."
  mkdir -p "$LOCAL_BIN"
  cp "$BUSYBOX_SRC" "$LOCAL_BIN/busybox"
  chmod +x "$LOCAL_BIN/busybox"

  if "$LOCAL_BIN/busybox" --list >/dev/null 2>&1; then
    "$LOCAL_BIN/busybox" --install -s "$LOCAL_BIN" 2>/dev/null || \
    for cmd in $("$LOCAL_BIN/busybox" --list); do
      ln -sf "$LOCAL_BIN/busybox" "$LOCAL_BIN/$cmd"
    done
    echo "[start.sh] BusyBox symlinks ready in $LOCAL_BIN."
  else
    echo "[start.sh] Warning: busybox is not executable in this environment, skipping symlinks."
  fi
else
  echo "[start.sh] busybox not found in $APP_DIR/bin/busybox or $HOME/bin/busybox, skipping."
fi

# 4. 确保当前启动进程及后续 node / 终端继承 PATH
if [ -d "$LOCAL_BIN" ]; then
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) ;;
    *) export PATH="$PATH:$LOCAL_BIN" ;;
  esac
fi

echo "[start.sh] Handing over to node index.js..."
exec node index.js
