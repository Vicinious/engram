#!/bin/bash
# Engram Installation Script
# Run as root or with sudo

set -e

echo "=== Engram Installation ==="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# Check root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root or with sudo${NC}"
    exit 1
fi

ENGRAM_DIR="/srv/openclaw-shared/engram"
ENGRAM_USER="engram"
ENGRAM_GROUP="openclaw-bots"

echo "[1/7] Creating engram user..."
if ! id "$ENGRAM_USER" &>/dev/null; then
    useradd -r -s /bin/false -g "$ENGRAM_GROUP" "$ENGRAM_USER" 2>/dev/null || \
    useradd -r -s /bin/false "$ENGRAM_USER"
    echo -e "${GREEN}Created user: $ENGRAM_USER${NC}"
else
    echo "User $ENGRAM_USER already exists"
fi

# Ensure user is in openclaw-bots group
usermod -aG "$ENGRAM_GROUP" "$ENGRAM_USER" 2>/dev/null || true

echo "[2/7] Creating directories..."
mkdir -p /var/lib/engram /var/run/engram /var/log/engram
chown $ENGRAM_USER:$ENGRAM_GROUP /var/lib/engram /var/run/engram /var/log/engram
chmod 755 /var/lib/engram /var/run/engram /var/log/engram
echo -e "${GREEN}Directories created${NC}"

echo "[3/7] Installing npm dependencies..."
cd "$ENGRAM_DIR"
/opt/node/bin/npm install --production
echo -e "${GREEN}Dependencies installed${NC}"

echo "[4/7] Making CLI executable..."
chmod +x src/cli.js
echo -e "${GREEN}CLI is executable${NC}"

echo "[5/7] Creating symlink for engram CLI..."
ln -sf "$ENGRAM_DIR/src/cli.js" /usr/local/bin/engram
echo -e "${GREEN}CLI available at: /usr/local/bin/engram${NC}"

echo "[6/7] Installing systemd service..."
cp "$ENGRAM_DIR/systemd/engram.service" /etc/systemd/system/
systemctl daemon-reload
echo -e "${GREEN}Service installed${NC}"

echo "[7/7] Starting service..."
systemctl enable engram
systemctl start engram
sleep 2

if systemctl is-active --quiet engram; then
    echo -e "${GREEN}✓ Engram is running!${NC}"
    echo ""
    engram status
else
    echo -e "${RED}✗ Engram failed to start${NC}"
    journalctl -u engram -n 20 --no-pager
    exit 1
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Quick start:"
echo "  engram status           # Check service"
echo "  engram wake --agent kevin  # Get context injection"
echo "  engram remember 'something' --type fact"
echo "  engram recall 'query'"
echo ""
echo "Logs: journalctl -u engram -f"
