#!/bin/bash
set -e

# Carrega o NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

APP_NAME="sinapsys-wpp-demo"
DEPLOY_DIR="/home/ubuntu/sinapsys-wpp-demo"
LOG_DIR="/var/log/sinapsys-wpp-demo"
NODE_VERSION="22.14.0"

# Usa a versão certa do Node
nvm use "$NODE_VERSION" || nvm install "$NODE_VERSION"

# Para a aplicação se já estiver rodando
if pm2 list | grep -q "$APP_NAME"; then
  pm2 stop "$APP_NAME"
fi

# Sincroniza apenas dist e package.json
rsync -av --delete \
  --include='dist/***' \
  --include='package*.json' \
  --exclude='*' \
  /tmp/sinapsys-wpp-deploy/ "$DEPLOY_DIR/"

# Instala deps em production
cd "$DEPLOY_DIR"
npm install --omit=dev --omit=optional --prefer-offline

# Reinicia ou inicia com PM2
pm2 restart ecosystem.config.js --only "$APP_NAME" \
  --log "$LOG_DIR/app.log" \
  --error "$LOG_DIR/error.log" \
  --output "$LOG_DIR/output.log" \
  --time || \
pm2 start ecosystem.config.js --only "$APP_NAME" --name "$APP_NAME" \
  --log "$LOG_DIR/app.log" \
  --error "$LOG_DIR/error.log" \
  --output "$LOG_DIR/output.log" \
  --time

pm2 save

echo "✅ Deploy de $APP_NAME concluído em $(date)"