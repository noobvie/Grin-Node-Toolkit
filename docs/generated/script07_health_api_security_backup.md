# Health API Security Strategy

Health endpoints reveal operational details that **must be protected carefully**. This guide shows what to expose, what to hide, and how to secure it.

---

## 1. The Threat Model

**What attackers can learn from health endpoints:**

```
Public /health (bad exposure)
↓
"Pool is operational"
→ Tells attackers pool exists and is running
→ Can be used to find when pool launches / goes down
→ Enables timing attacks

GET /api/admin/health/node (if exposed)
↓
"Node height: 5123456, peers: 4, synced: true"
→ Tells attackers how far synced you are
→ Reveals your blockchain position
→ Can infer your network location (timing attacks)

GET /api/admin/health/wallet (if exposed)
↓
"Balance: 150.5 GRIN"
→ Tells attackers how much you hold
→ Attracts theft/ransom attacks
→ Reveals payout schedule (can predict next withdrawal)

GET /api/admin/health/stratum (if exposed)
↓
"Active miners: 45, rejection_rate: 0.27%"
→ Tells attackers pool size & hashrate
→ Reveals pool's mining power to competitors
→ Can be used for competitive sabotage
```

---

## 2. Security Tiers

### **Tier 1: Public (Unauthenticated, No IP Restriction)**

```javascript
GET /health
Response: {
  "status": "ok",
  "timestamp": "2026-05-15T12:34:56Z"
}
```

✅ **Safe to expose** — No sensitive information  
✅ **Used by:** Load balancers, external monitoring, uptime checkers  
✅ **Rate limit:** HIGH (60+ req/min) — monitoring tools need frequent checks  
✅ **Caching:** OK to cache 30 seconds (load balancer health checks)

---

### **Tier 2: Admin-Only (Authenticated, Should Have IP Allowlist)**

```javascript
GET /api/admin/health/node
GET /api/admin/health/wallet
GET /api/admin/health/stratum
```

❌ **DANGEROUS to expose publicly** — Leaks operational details  
✅ **Safe if:** Behind authentication (JWT required) + IP allowlist  
🔴 **Rate limit:** MEDIUM (10 req/min) — admin tools only  
🔴 **Never cache** — Health status changes need real-time visibility

**What's leaked:**
- Node height, peer count, sync status → blockchain position
- Wallet balance, balance_locked → assets under management
- Tor status, Tor reachability → attack surface for payouts
- Stratum active connections, rejection rate → pool size/power

---

### **Tier 3: Internal (Backend-to-Backend Only)**

Not exposed via HTTP at all. Called directly from within pool code:

```javascript
const nodeHealth = blockMonitor.grinNode.getStatus();
const walletHealth = walletTor.checkHealth();
```

✅ **Safest** — No network exposure  
✅ **Used by:** Alert system, dashboard aggregation

---

## 3. Secure Configuration

### **Production Defaults** (in CONFIG_SCHEMA.md)

```json
{
  "health_api_tier": "admin_only",
  "health_public_endpoint_enabled": true,
  "health_admin_require_ip_allowlist": true,
  "admin_ip_allowlist": [
    "203.0.113.0/24"
  ],
  "health_cache_seconds": 30,
  "health_rate_limits": {
    "public": 60,
    "admin": 10
  }
}
```

### **Option A: Conservative (Recommended for Production)**

```json
{
  "health_public_endpoint_enabled": true,
  "health_admin_require_ip_allowlist": true,
  "admin_ip_allowlist": ["203.0.113.0/24", "198.51.100.0/25"],
  "health_rate_limits": {
    "public": 60,
    "admin": 10
  }
}
```

- ✅ Public `/health` enabled (lightweight monitoring)
- ✅ Admin health endpoints require IP allowlist
- ✅ If IP allowlist is set, `/api/admin/health/*` returns 403 to unauthorized IPs
- ✅ Rate limiting prevents abuse

### **Option B: Paranoid (For High-Security Deployments)**

```json
{
  "health_public_endpoint_enabled": false,
  "health_admin_require_ip_allowlist": true,
  "admin_ip_allowlist": ["203.0.113.42"]
}
```

- ❌ No public health endpoint at all
- ✅ Admin health endpoints only from IP 203.0.113.42
- ⚠️ External monitoring (load balancer, Prometheus) won't work
- ⚠️ Harder to debug issues

### **Option C: Relaxed (Development Only, NOT Production)**

```json
{
  "health_public_endpoint_enabled": true,
  "health_admin_require_ip_allowlist": false,
  "health_rate_limits": {
    "public": 300,
    "admin": 300
  }
}
```

- ❌ Admin health endpoints exposed to anyone
- ❌ Only protection is rate limiting
- ✅ Easy for testing/development

---

## 4. Implementation: Secure Health Endpoints

### **4.1 Public Endpoint (Safe)**

```javascript
app.get('/health', (req, res) => {
  // Minimal response — no sensitive data
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});
```

**Middleware to add:**
- ✅ Rate limiting: 60 req/min per IP
- ✅ Caching: 30 seconds (ETag support)
- ✅ No auth required

---

### **4.2 Admin Health Endpoints (Secured)**

```javascript
// Middleware: Check IP allowlist if enabled
const checkHealthIpAllowlist = (req, res, next) => {
  const allowlist = config.admin_ip_allowlist;
  
  if (!allowlist || allowlist.length === 0) {
    // Allowlist disabled — only auth required
    return requireAdmin(authManager)(req, res, next);
  }
  
  // Allowlist enabled — check IP first
  const clientIp = req.ip || req.connection.remoteAddress;
  const isAllowed = allowlist.some(ip => {
    if (ip.includes('/')) {
      // CIDR check
      return ipInCidr(clientIp, ip);
    }
    return clientIp === ip;
  });
  
  if (!isAllowed) {
    return res.status(403).json({
      error: 'Access denied: IP not in allowlist',
      your_ip: clientIp
    });
  }
  
  // Then check auth
  return requireAdmin(authManager)(req, res, next);
};

// Protected endpoint
app.get('/api/admin/health/node', checkHealthIpAllowlist, (req, res) => {
  const status = blockMonitor.grinNode.getStatus();
  res.json(status);
});

app.get('/api/admin/health/wallet', checkHealthIpAllowlist, (req, res) => {
  const status = walletTor.getHealthStatus();
  res.json(status);
});

app.get('/api/admin/health/stratum', checkHealthIpAllowlist, (req, res) => {
  const status = stratumServer.getHealthStatus();
  res.json(status);
});
```

**Middleware chain:**
1. Rate limit (10 req/min for admin endpoints)
2. Check IP allowlist (if enabled)
3. Check JWT auth
4. Return health data

---

## 5. What Each Endpoint Should Return

### **Public `/health` — MINIMAL**

```json
{
  "status": "ok",
  "timestamp": "2026-05-15T12:34:56Z"
}
```

✅ Safe. No PII, no amounts, no positions.

---

### **Admin `/api/admin/health/node` — OPERATIONAL ONLY**

```json
{
  "status": "healthy",
  "checks": {
    "api_reachable": {
      "status": "ok",
      "latency_ms": 45
    },
    "sync_status": {
      "status": "ok",
      "synced": true
    },
    "peers": {
      "status": "ok",
      "count": 4
    },
    "difficulty": {
      "status": "ok",
      "trend": "stable"
    }
  }
}
```

⚠️ **REDACTED** — Don't return:
- ❌ Absolute block height (reveals sync position)
- ❌ Peer IP addresses (reveals network topology)
- ❌ Exact difficulty values (enables fingerprinting)
- ❌ Node version (enables version-specific attacks)

✅ **Safe to return:**
- ✅ Status: "ok", "warning", "critical"
- ✅ Latency: "45ms" (no timing attacks)
- ✅ Trends: "stable", "increasing", "decreasing"
- ✅ Checks: reachable, synced, connected, etc.

---

### **Admin `/api/admin/health/wallet` — BALANCE REDACTED**

```json
{
  "status": "healthy",
  "checks": {
    "api_reachable": {
      "status": "ok",
      "latency_ms": 52
    },
    "tor_reachable": {
      "status": "ok"
    },
    "balance": {
      "status": "ok",
      "has_sufficient_funds": true,
      "percentage_of_min_required": 310
    },
    "synced": {
      "status": "ok"
    }
  }
}
```

⚠️ **REDACTED** — Don't return:
- ❌ Actual balance: 150.5 GRIN (reveals assets)
- ❌ Locked balance amounts (reveals pending payouts)
- ❌ Transaction history (reveals payout patterns)
- ❌ Tor endpoint IP (reveals payout infrastructure)

✅ **Safe to return:**
- ✅ Status: "ok", "warning", "critical"
- ✅ Has sufficient funds: true/false
- ✅ Percentage of minimum: "310%" (normalized)
- ✅ Tor connectivity: "reachable", "unreachable"

---

### **Admin `/api/admin/health/stratum` — COUNTS ONLY**

```json
{
  "status": "healthy",
  "metrics": {
    "listening": true,
    "active_connections": 45,
    "active_miners": 23,
    "rejection_rate_percent": 0.27,
    "connection_errors_1h": 2
  }
}
```

⚠️ **REDACTED** — Don't return:
- ❌ Hashrate in GPS (reveals mining power)
- ❌ Difficulty values (enables fingerprinting)
- ❌ Miner list or IP addresses (reveals participants)
- ❌ Worker names (reveals customer info)

✅ **Safe to return:**
- ✅ Connection count: "45" (operational metric)
- ✅ Miner count: "23" (pool size, already public)
- ✅ Rejection rate: "0.27%" (quality metric)
- ✅ Error count: "2 in last hour" (diagnostic)

---

## 6. Rate Limiting Strategy

### **Public `/health`**

```javascript
// High limit — external monitoring tools need frequent checks
rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 60,                   // 60 requests/min = 1 req/sec
  keyGenerator: (req) => req.ip
})
```

**Rationale:**
- Load balancers check every 10-30 seconds
- Prometheus scrapers check every 30 seconds
- Multiple monitoring services may all check
- 60 req/min is safe (1 per second average)

### **Admin `/api/admin/health/*`**

```javascript
// Strict limit — only admins should call
rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 10,                   // 10 requests/min
  keyGenerator: (req) => req.ip
})
```

**Rationale:**
- Admin dashboard probably calls every 30 sec
- Monitoring tools call every 5-10 min
- 10 req/min is plenty for humans + tools
- Prevents brute-force information gathering

---

## 7. Logging & Monitoring Health Checks

### **What to LOG**

```
[2026-05-15T12:34:56Z] Health check: GET /health from 203.0.113.42 → 200 OK
[2026-05-15T12:34:57Z] Health check: GET /api/admin/health/node from 203.0.113.42 (auth: ok) → 200 OK
```

✅ Safe to log: endpoint, IP, auth result, status code

### **What NOT to log**

```
❌ [2026-05-15T12:34:56Z] Health check: Node height 5123456, peers 8, hashrate 1000 GPS
❌ [2026-05-15T12:34:57Z] Health check: Wallet balance 150.5 GRIN, locked 45.0 GRIN
```

⚠️ Never log sensitive health details to log file (it can be read by attackers)

---

## 8. Dashboard Usage (Admin Panel)

### **How Dashboard Calls Health Endpoints**

```javascript
// Admin dashboard calls health endpoints every 30 seconds
async function refreshDashboard() {
  try {
    const nodeHealth = await fetch('/api/admin/health/node', {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    const walletHealth = await fetch('/api/admin/health/wallet', {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    const stratumHealth = await fetch('/api/admin/health/stratum', {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    
    updateDashboard(nodeHealth, walletHealth, stratumHealth);
  } catch (err) {
    showError('Health check failed: ' + err.message);
  }
}
```

✅ Uses JWT token  
✅ Calls from allowed IP (if allowlist enabled)  
✅ Respects rate limits (30-sec refresh = 2 req/min per endpoint)

---

## 9. External Monitoring (Prometheus, Datadog, etc.)

### **Setup Prometheus Scraping**

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'grin-pool'
    scrape_interval: 30s
    static_configs:
      - targets: ['pool.example.com']
    # Use public endpoint (no auth needed)
    metrics_path: '/metrics'
    
    # Or use admin endpoint with auth
    bearer_token: '<your-api-token>'
```

**Recommendation:**
- Use `/metrics` endpoint (if enabled) — returns Prometheus format
- If not available, use `/health` — minimal data
- Avoid calling `/api/admin/health/*` from external service (requires IP allowlist setup)

---

## 10. Security Checklist

### **For Production**

- [ ] `/health` endpoint enabled (public, minimal data)
- [ ] `/api/admin/health/*` endpoints require JWT auth
- [ ] `/api/admin/health/*` endpoints require IP allowlist (or empty list)
- [ ] Rate limiting: 60 req/min for `/health`, 10 req/min for admin
- [ ] No PII/amounts logged from health checks
- [ ] Admin health responses redacted (no balance, no height, no hashrate)
- [ ] IP allowlist includes your monitoring tools' IPs
- [ ] Test that unauthorized IPs get 403 Forbidden
- [ ] Test that missing JWT gets 401 Unauthorized
- [ ] Monitor health endpoint access in audit log

### **For Development**

- [ ] You can disable IP allowlist for testing
- [ ] Public `/health` can be called without auth
- [ ] Admin endpoints need JWT or IP allowlist

---

## 11. Configuration Example

```json
{
  "health_api_tier": "admin_only",
  "health_public_endpoint_enabled": true,
  "health_admin_require_ip_allowlist": true,
  "admin_ip_allowlist": [
    "203.0.113.0/24",
    "198.51.100.42",
    "192.0.2.0/25"
  ],
  "health_rate_limits": {
    "public": 60,
    "admin": 10
  },
  "health_cache_seconds": 30
}
```

---

## 12. Summary: Secure Health API Usage

| Endpoint | Auth | IP Allowlist | Rate Limit | Data Exposed |
|----------|------|-------------|-----------|--------------|
| `GET /health` | ❌ No | ❌ No | 60/min | Status only |
| `GET /api/admin/health/node` | ✅ JWT | ✅ Yes | 10/min | Health status (no height) |
| `GET /api/admin/health/wallet` | ✅ JWT | ✅ Yes | 10/min | Health status (no balance) |
| `GET /api/admin/health/stratum` | ✅ JWT | ✅ Yes | 10/min | Health status (no hashrate) |
| `GET /metrics` | ✅ JWT | ✅ Yes | 10/min | Prometheus metrics (redacted) |

**Golden Rule:** Minimize what's exposed. Attackers learn from health endpoints — every detail you leak is reconnaissance intelligence.
