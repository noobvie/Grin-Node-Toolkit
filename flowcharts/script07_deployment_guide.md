# GRINIUM Mining Pool — Deployment Guide & Testing Checklist

**Date:** 2026-05-15  
**Version:** 1.0 MVP  
**Status:** Ready for Production Deployment

---

## Table of Contents
1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Local Testing (Development)](#local-testing-development)
3. [Staging Testing (VPS)](#staging-testing-vps)
4. [Production Deployment](#production-deployment)
5. [Post-Deployment Verification](#post-deployment-verification)
6. [Troubleshooting Guide](#troubleshooting-guide)
7. [Monitoring & Maintenance](#monitoring--maintenance)

---

## Pre-Deployment Checklist

### Code Quality
- [ ] **Syntax Validation**
  ```bash
  node -c web/07_mining_pool/back-end-pool/index.js
  # Expected: ✅ (no output = success)
  ```

- [ ] **All Files Organized**
  ```bash
  flowcharts/
  ├── script07_design_specification.md
  ├── script07_implementation_guide.md
  ├── script07_deployment_guide.md
  └── (other reference docs)
  ```

- [ ] **Dependencies Installed**
  ```bash
  cd web/07_mining_pool/back-end-pool
  npm install
  npm list  # Verify all packages present
  ```

### Configuration Ready
- [ ] **pool.json template exists** at `back-end-pool/pool.json.template`
- [ ] **package.json** has correct scripts:
  - `npm start` → `node index.js`
  - `npm run check-syntax`

- [ ] **Frontend files complete**
  ```bash
  ls web/07_mining_pool/public_html/
  ✅ index.html
  ✅ admin-dashboard.html
  ✅ miners-stats.html
  ✅ payment-history.html
  ✅ system-health.html
  ✅ account-settings.html
  ✅ pool-info.html
  ✅ login.html
  ✅ js/auth.js
  ```

### Git Status Clean
- [ ] All changes committed
  ```bash
  git status  # Should be clean
  git log --oneline | head -5  # Recent commits visible
  ```

---

## Local Testing (Development)

### Phase 1: Backend Startup

#### 1.1 Start Node.js Backend
```bash
cd web/07_mining_pool/back-end-pool
npm start
```

**Expected Output:**
```
[2026-05-15T12:34:56.123Z] Loading pool configuration...
[2026-05-15T12:34:56.456Z] Database initialized at ./pool.db
[2026-05-15T12:34:56.789Z] Wallet API initialized (testnet)
[2026-05-15T12:34:57.000Z] Mining managers initialized
[2026-05-15T12:34:57.100Z] Stratum server listening on port 3416
[2026-05-15T12:34:57.200Z] Block monitor started
[2026-05-15T12:34:57.300Z] Pool API listening on port 3002
```

✅ **If you see "listening on port 3002"** → Backend is ready

❌ **If you see errors:**
- Check Node.js version: `node -v` (should be >= 18.0.0)
- Check port 3002 not in use: `lsof -i :3002`
- Check database permissions: `ls -la pool.db`

#### 1.2 Test Health Endpoint
```bash
curl http://localhost:3002/api/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "network": "testnet",
  "timestamp": "2026-05-15T12:34:56Z"
}
```

✅ **200 response with status: ok** → Backend is working

### Phase 2: Authentication Testing

#### 2.1 Register Admin Account
```bash
curl -X POST http://localhost:3002/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"TestPass123!"}' | jq
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Admin user created",
  "user_id": 1
}
```

✅ **status: 201 or 200 with success: true**
❌ **If duplicate error:** User already exists, try different username

#### 2.2 Login to Get Token
```bash
TOKEN=$(curl -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"TestPass123!"}' | jq -r '.access_token')

echo "Token: $TOKEN"
```

**Expected Response:**
```json
{
  "success": true,
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

✅ **Token received and stored in $TOKEN variable**
❌ **Invalid password:** Check credentials, re-register if needed

#### 2.3 Test Protected Endpoint with Token
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/dashboard | jq
```

**Expected Response:**
```json
{
  "timestamp": "2026-05-15T12:34:56Z",
  "pool_status": { "name": "GRINIUM", "uptime_hours": 730.5 },
  "stratum_metrics": { "active_connections": 0, "active_miners": 0 },
  "hashrate": { "current_gps": 0, "avg_24h_gps": 0 },
  ...
}
```

✅ **200 response with dashboard data**
❌ **401 Unauthorized:** Token is invalid or expired

### Phase 3: API Endpoint Testing

#### 3.1 Test Public Endpoints (No Auth)
```bash
# Pool stats (public)
curl http://localhost:3002/api/pool/stats | jq

# Top miners (public)
curl http://localhost:3002/api/miners/top?limit=5 | jq

# Stratum stats (public)
curl http://localhost:3002/api/stratum/stats | jq
```

**Expected:** All return 200 with empty/default data

#### 3.2 Test Admin Endpoints (With Auth)
```bash
# Admin dashboard
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/dashboard | jq

# Node health
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/health/node | jq

# Wallet health
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/health/wallet | jq

# Withdrawals
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/withdrawals | jq
```

**Expected:** All return 200 with health/status data

#### 3.3 Test Account Update
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","min_payout":15.0,"theme":"light"}' \
  http://localhost:3002/api/account/update | jq
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Settings updated",
  "user_id": 1,
  "updated_at": "2026-05-15T12:34:56Z"
}
```

✅ **success: true**
❌ **error:** Check input validation (min_payout >= 0.1)

### Phase 4: Frontend Testing

#### 4.1 Open Login Page
```bash
# Option 1: Use local file (won't work for API calls)
# Open: file:///path/to/public_html/login.html

# Option 2: Serve with Python (test API calls)
cd web/07_mining_pool/public_html
python3 -m http.server 8000
# Then open: http://localhost:8000/login.html
```

#### 4.2 Test Login Flow
1. Open `http://localhost:8000/login.html`
2. Enter username: `admin`
3. Enter password: `TestPass123!`
4. Click "Login"

**Expected:**
- ✅ Login button shows "Logging in..." spinner
- ✅ After 2-3 seconds, redirects to `admin-dashboard.html`
- ✅ Browser console has no errors
- ✅ Check DevTools → Application → LocalStorage → `access_token` present

#### 4.3 Test Admin Dashboard
1. Should have loaded on successful login
2. Check stat cards:
   - ✅ Active Miners: 0 (no miners connected yet)
   - ✅ Total Hashrate: 0 GPS
   - ✅ Network Fee: 1.5%
   - ✅ Last Block: 0h (or N/A)

3. Check Tables:
   - ✅ Recent Pool Activity table loads (may be empty)
   - ✅ Pool Statistics table loads

4. Check Auto-Refresh:
   - ✅ Data refreshes every 30 seconds
   - ✅ Network tab shows repeated API calls

#### 4.4 Test Other Pages
1. Navigate to each page via header/menu:
   - ✅ `index.html` — Home (public stats)
   - ✅ `miners-stats.html` — Miners rankings
   - ✅ `payment-history.html` — Payouts
   - ✅ `system-health.html` — Health status
   - ✅ `account-settings.html` — Settings form
   - ✅ `pool-info.html` — Info page

2. Verify each page:
   - ✅ Loads without errors
   - ✅ API calls are made (check Network tab)
   - ✅ Data displays or shows "no data"
   - ✅ Theme switcher works (Dark/Light/Atomic)

#### 4.5 Test Error Scenarios
```bash
# Invalid token
curl -H "Authorization: Bearer invalid_token" \
  http://localhost:3002/api/admin/dashboard
# Expected: 401 Unauthorized

# Missing token (protected endpoint)
curl http://localhost:3002/api/admin/dashboard
# Expected: 401 Unauthorized

# Invalid input
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"min_payout":-5}' \
  http://localhost:3002/api/account/update
# Expected: 400 Bad Request, error message
```

### Phase 5: Database Validation

#### 5.1 Check Database Created
```bash
cd web/07_mining_pool/back-end-pool
ls -la pool.db

# Should see: -rw-r--r-- ... pool.db
```

#### 5.2 Check Tables Exist
```bash
sqlite3 pool.db ".tables"
# Expected output:
# admin_audit_log  blocks           miner_accounts   shares
# user_settings    users            withdrawals
```

#### 5.3 Check Admin User Created
```bash
sqlite3 pool.db "SELECT id, username, is_admin FROM users;"
# Expected output:
# 1|admin|1
```

#### 5.4 Check Settings Saved
```bash
sqlite3 pool.db "SELECT * FROM user_settings;"
# Expected output (after account update):
# 1|admin@example.com|US East|15.0|all|light|...
```

---

## Staging Testing (VPS)

### Pre-Deployment Steps

#### 1. Provision VPS
```bash
# Requirements:
# - Ubuntu 22.04 LTS or Rocky Linux 9
# - 2+ CPU cores
# - 4+ GB RAM
# - 20+ GB disk
# - Open ports: 80, 443 (nginx), 3416 (stratum), 13414 (testnet)
```

#### 2. Copy Files to VPS
```bash
# From your local machine:
scp -r web/07_mining_pool/back-end-pool/* root@VPS_IP:/opt/grin/pool/mainnet/
scp -r web/07_mining_pool/public_html/* root@VPS_IP:/var/www/grin-pool/
scp scripts/07_grin_mining_services.sh root@VPS_IP:/root/
```

#### 3. Run Setup Script
```bash
ssh root@VPS_IP
bash 07_grin_mining_services.sh
# Follow guided menu:
# 7 (Mining services)
# W (Pool web interface)
# G (Guided full setup)
```

#### 4. Verify Deployment
```bash
# Check service started
systemctl status grin-pool-manager

# Check logs
tail -f /opt/grin/logs/grin-pool.log

# Check ports listening
ss -tlnp | grep -E "3002|3416"

# Test API
curl http://localhost:3002/api/health
```

### Staging Testing Scenarios

#### Test 1: API Connectivity
```bash
# From your local machine:
curl http://YOUR_VPS_IP:3002/api/health

# Expected: 200 OK with status
```

#### Test 2: Frontend Serving
```bash
# Open browser:
http://YOUR_VPS_IP/login.html

# Expected: Login page loads with styles
```

#### Test 3: Full Authentication Flow
```bash
# 1. Register admin on VPS
curl -X POST http://YOUR_VPS_IP:3002/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"VPSpass123!"}'

# 2. Login
TOKEN=$(curl -X POST http://YOUR_VPS_IP:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"VPSpass123!"}' \
  | jq -r '.access_token')

# 3. Test protected endpoint
curl -H "Authorization: Bearer $TOKEN" \
  http://YOUR_VPS_IP:3002/api/admin/dashboard | jq '.pool_status'
```

#### Test 4: Frontend Login via Browser
1. Open `http://YOUR_VPS_IP/login.html`
2. Register new admin account
3. Login with credentials
4. Verify redirect to admin dashboard
5. Check that data loads

#### Test 5: Nginx Routing
```bash
# API routing
curl http://YOUR_VPS_IP/api/health
# Expected: 200 with status

# Static file serving
curl http://YOUR_VPS_IP/index.html | head -5
# Expected: HTML document starts with <!DOCTYPE html>

# SSL/TLS (if configured)
curl -k https://YOUR_VPS_IP/api/health
# Expected: 200 with status
```

---

## Production Deployment

### Step 1: Backup Current System (if upgrading)
```bash
# Backup database
cp /opt/grin/pool/mainnet/pool.db /opt/grin/backups/pool.db.$(date +%Y%m%d)

# Backup config
cp /opt/grin/conf/grin_pool.json /opt/grin/backups/config.json.$(date +%Y%m%d)

# Backup frontend
tar czf /opt/grin/backups/www-grin-pool.$(date +%Y%m%d).tar.gz /var/www/grin-pool
```

### Step 2: Deploy New Code
```bash
# Stop service
systemctl stop grin-pool-manager

# Copy new backend
cp -r web/07_mining_pool/back-end-pool/* /opt/grin/pool/mainnet/

# Copy new frontend
cp -r web/07_mining_pool/public_html/* /var/www/grin-pool/

# Verify permissions
chown -R grin:grin /opt/grin/pool/mainnet/
chown -R www-data:www-data /var/www/grin-pool
```

### Step 3: Database Migrations
```bash
# SSH to VPS
ssh root@VPS_IP

# Run migration (if needed)
cd /opt/grin/pool/mainnet
node -e "require('./lib/db').initDb('./pool.db')"

# Verify new tables
sqlite3 pool.db ".tables"
```

### Step 4: Start Service
```bash
systemctl start grin-pool-manager

# Verify startup
sleep 5
systemctl status grin-pool-manager

# Check logs
tail -50 /opt/grin/logs/grin-pool.log
```

### Step 5: Smoke Tests
```bash
# 1. Health check
curl http://localhost:3002/api/health

# 2. API responds
curl http://localhost:3002/api/pool/stats

# 3. Frontend loads
curl -I http://localhost/login.html

# 4. All critical endpoints
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/dashboard
```

---

## Post-Deployment Verification

### Immediate Checks (First 5 minutes)

```bash
# 1. Service running
systemctl is-active grin-pool-manager
# Expected: active

# 2. No startup errors
grep -i "error\|exception" /opt/grin/logs/grin-pool.log | head -5
# Expected: No critical errors

# 3. Database accessible
sqlite3 /opt/grin/pool/mainnet/pool.db "SELECT COUNT(*) FROM users;"
# Expected: 1 (admin user)

# 4. Port listening
ss -tlnp | grep 3002
# Expected: Node.js listening on 0.0.0.0:3002

# 5. Frontend accessible
curl -I http://localhost/login.html | head -3
# Expected: HTTP/1.1 200 OK
```

### Comprehensive Verification (First 24 hours)

#### Performance Metrics
```bash
# Response times
time curl http://localhost:3002/api/pool/stats
# Expected: < 200ms

# Database query time
sqlite3 /opt/grin/pool/mainnet/pool.db "EXPLAIN QUERY PLAN SELECT * FROM miner_accounts LIMIT 10;"
# Look for: no FULL SCANs on large tables

# Memory usage
ps aux | grep node
# Check: reasonable memory (< 500MB for idle pool)
```

#### Security Checks
```bash
# 1. No exposed secrets
grep -r "password\|secret\|token" /opt/grin/pool/mainnet/*.js | grep -v "// " | wc -l
# Expected: 0 (no hardcoded secrets)

# 2. HTTPS enforced
curl -I http://localhost/login.html | grep -i "strict\|upgrade"
# Expected: Security headers present

# 3. Authentication required
curl http://localhost:3002/api/admin/dashboard
# Expected: 401 Unauthorized (no token)

# 4. Rate limiting works
for i in {1..20}; do curl -s http://localhost:3002/api/health; done | grep -c "error"
# Expected: Some requests rate limited after threshold
```

#### Functional Verification
```bash
# 1. Login works
TOKEN=$(curl -s -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}' | jq -r '.access_token')
[ -n "$TOKEN" ] && echo "✅ Login works" || echo "❌ Login failed"

# 2. Dashboard loads
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/dashboard | jq '.timestamp' && echo "✅ Dashboard OK"

# 3. Miner endpoints work
curl -s http://localhost:3002/api/miners/top | jq '.[0].grin_address' && echo "✅ Miners OK"

# 4. Health checks work
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/health/node | jq '.status' && echo "✅ Health checks OK"
```

---

## Troubleshooting Guide

### Issue: Backend won't start

**Error:** `Address already in use`
```bash
# Solution: Check what's using port 3002
lsof -i :3002
kill -9 <PID>

# Or change port in pool.json config
```

**Error:** `Cannot find module`
```bash
# Solution: Reinstall dependencies
cd /opt/grin/pool/mainnet
npm install
```

**Error:** `Database error`
```bash
# Solution: Reset database
rm -f pool.db
systemctl restart grin-pool-manager
```

### Issue: Frontend shows "Failed to load data"

**Check:**
1. Backend is running: `curl http://localhost:3002/api/health`
2. CORS not blocking: Check browser console for CORS errors
3. Auth token expired: Login again
4. API endpoint exists: Test with curl

**Solution:**
```bash
# 1. Restart backend
systemctl restart grin-pool-manager

# 2. Clear browser cache
# Ctrl+Shift+Delete → Clear All

# 3. Check logs
tail -50 /opt/grin/logs/grin-pool.log
```

### Issue: Database locked

**Error:** `database is locked`
```bash
# Solution: Close other connections
lsof | grep pool.db
kill -9 <PID>

# Or wait a few minutes for timeout
```

### Issue: Nginx routing not working

**Check:**
1. Nginx running: `systemctl status nginx`
2. Config syntax: `nginx -t`
3. Site enabled: `ls -la /etc/nginx/sites-enabled/ | grep grin-pool`

**Solution:**
```bash
# 1. Test Nginx config
nginx -t
# Expected: successful

# 2. Reload Nginx
systemctl reload nginx

# 3. Check proxy settings
curl -v http://localhost/api/health 2>&1 | grep -i "host\|proxy"
```

---

## Monitoring & Maintenance

### Daily Checks
```bash
# 1. Service status
systemctl status grin-pool-manager

# 2. Recent errors
grep "ERROR\|WARN" /opt/grin/logs/grin-pool.log | tail -20

# 3. Database size
du -sh /opt/grin/pool/mainnet/pool.db

# 4. Disk space
df -h / | head -2

# 5. Memory usage
free -h
```

### Weekly Tasks
```bash
# 1. Backup database
tar czf /opt/grin/backups/pool-$(date +%Y%m%d).tar.gz \
  /opt/grin/pool/mainnet/pool.db

# 2. Vacuum database (cleanup)
sqlite3 /opt/grin/pool/mainnet/pool.db "VACUUM;"

# 3. Check log rotation
ls -lt /opt/grin/logs/ | head -5

# 4. Verify disk space is adequate
df -h / | awk '{print $5}' | head -2  # Should be < 80%
```

### Monthly Reviews
- [ ] Review admin_audit_log for suspicious activity
- [ ] Verify all API endpoints responding
- [ ] Test disaster recovery (restore from backup)
- [ ] Update documentation with lessons learned
- [ ] Security review of firewall rules

---

## Launch Checklist - Before Going Live

- [ ] All tests passing (local & VPS)
- [ ] Database backups working
- [ ] Monitoring/alerting configured
- [ ] Admin trained on basic operations
- [ ] DNS pointing to correct IP
- [ ] SSL certificate valid
- [ ] Firewall rules in place
- [ ] Rate limits tuned for production
- [ ] Logging to persistent storage
- [ ] Error reporting configured

---

## Summary

**DEPLOYMENT COMPLETE** when:
✅ Backend starts without errors  
✅ All API endpoints respond  
✅ Frontend loads and authenticates  
✅ Data flows correctly  
✅ Tests pass on VPS  
✅ Monitoring active  
✅ Backups verified  

**Ready for: PRODUCTION LAUNCH** 🚀

