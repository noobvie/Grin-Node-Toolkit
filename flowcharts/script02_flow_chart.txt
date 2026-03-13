╔══════════════════════════════════════════════════════════════════════════╗
║                  02_nginx_fileserver_manager.sh  —  ENTRY               ║
╚══════════════════════════════════════════════════════════════════════════╝
                                    │
                    ┌───────────────▼───────────────┐
                    │   check_root()                 │
                    │   parse_arguments()            │
                    │   mkdir LOG_DIR                │
                    └───────────────────────────────┘
                                    │
              ┌─────────────────────┴─────────────────────┐
              │                                           │
        --action flag set                         no flag (interactive)
              │                                           │
    set LOG_FILE + tee                          ┌─────────▼──────────┐
    _dispatch_action()                          │    MAIN MENU LOOP  │
    finalize_log()                              │                    │
    exit                                        │  1) Grin Domain    │
                                                │  2) Custom Domain  │
                                                │  3) Remove Domain  │
                                                │  4) List Domains   │
                                                │  5) Limit Rate     │
                                                │  6) Lift Rate      │
                                                │  7) fail2ban Setup │
                                                │  8) fail2ban Mgmt  │
                                                │  9) IP Filtering   │
                                                │  0) Exit           │
                                                └─────────┬──────────┘
                                                          │
                      ┌───────────┬──────────┬───────────┼──────────────┬───────────┬──────────┬──────────┬──────────┐
                      │           │          │           │              │           │          │          │          │
                    [1]         [2]        [3]          [4]           [5]         [6]        [7]        [8]        [9]
                      │           │          │           │              │           │          │          │          │
            ══════════▼══   ══════▼══  ══════▼══   ══════▼══   ════════▼════  ════▼════  ════▼════  ════▼════  ════▼════
            GRIN DOMAIN   CUSTOM DOM  REMOVE DOM   LIST DOMS   LIMIT RATE    LIFT RATE  FAIL2BAN  FAIL2BAN   IP FILTER
            ═════════════  ═════════  ══════════   ══════════  ═════════════  =========  SETUP     MGMT       =========
══════════════════════════════════════════════════════════
[1] run_setup_grin()  /  [2] run_setup_custom()
══════════════════════════════════════════════════════════

    ┌──────────────────────────────┐
    │  check_nginx()               │
    │  nginx installed?            │
    └──────────────────────────────┘
          no ↓           yes ↓
    prompt install       continue
    yes → install_nginx()
    no  → return to menu
                    │
    ┌──────────────────────────────┐
    │  check_certbot()             │
    │  certbot installed?          │
    └──────────────────────────────┘
          no ↓           yes ↓
    prompt install       continue
    yes → install_certbot()
    no  → return to menu
                    │
    ┌──────────────────────────────┐
    │  get_domain()                │
    │  [1] strict (Grin only):     │  ← fullmain.* / prunemain.* / prunetest.*
    │  [2] loose (Custom):         │  ← any valid domain
    │  validate loop until valid   │
    └──────────────────────────────┘
                    │
    ┌──────────────────────────────┐
    │  get_email()                 │
    │  validate loop until valid   │
    └──────────────────────────────┘
                    │
    ┌──────────────────────────────┐
    │  get_files_directory()       │
    │                              │
    │  Grin running on 3414/13414? │
    │   yes → suggest web dirs     │
    │          from /proc/$pid     │
    │   no  → manual path prompt   │
    │          default:            │
    │          /var/www/fileserver │
    └──────────────────────────────┘
                    │
    ┌──────────────────────────────┐
    │  get_bandwidth_settings()    │
    │                              │
    │  Enable bandwidth limit? y/n │
    │   yes → quota (GB)           │
    │          speed after quota   │
    │          normal speed limit  │
    │   no  → skip                 │
    └──────────────────────────────┘
                    │
    ┌──────────────────────────────┐
    │  Confirmation loop           │
    │  show summary                │
    │  y=proceed / n=cancel / 0=exit│
    └──────────────────────────────┘
                    │ y
    ┌──────────────────────────────┐
    │  create_files_directory()    │
    │  mkdir -p FILES_DIR          │
    │  chown www-data              │
    │  chmod 755                   │
    │  create .htaccess            │
    │  (Options +Indexes)          │
    └──────────────────────────────┘
                    │
    ┌──────────────────────────────┐
    │  create_initial_nginx_config()│
    │                              │
    │  /etc/nginx/sites-available/ │
    │  $DOMAIN  ← HTTP only config │
    │  ┌─────────────────────────┐ │
    │  │ listen 80               │ │
    │  │ server_name $DOMAIN     │ │
    │  │ root $FILES_DIR         │ │
    │  │ autoindex on            │ │
    │  │ client_max_body_size 1G │ │
    │  │ security headers        │ │
    │  └─────────────────────────┘ │
    │  ln -s → sites-enabled       │
    │  nginx -t + reload           │
    └──────────────────────────────┘
                    │
    ┌──────────────────────────────┐
    │  obtain_ssl_certificate()    │
    │  certbot --nginx             │
    │    -d $DOMAIN                │
    │    --non-interactive         │
    │    --agree-tos               │
    │    --email $EMAIL            │
    │    --redirect                │
    │                              │
    │  fail ──────────────────→   │
    │  print diagnostic tips       │
    │  exit 1                      │
    └──────────────────────────────┘
                    │ success
    ┌──────────────────────────────┐
    │  enhance_nginx_config()      │
    │  backup original config      │
    │                              │
    │  rewrite config with:        │
    │  ┌──── HTTP block ─────────┐ │
    │  │ listen 80               │ │
    │  │ return 301 https://...  │ │
    │  └─────────────────────────┘ │
    │  ┌──── HTTPS block ────────┐ │
    │  │ listen 443 ssl http2    │ │
    │  │ ssl_certificate         │ │
    │  │ ssl_certificate_key     │ │
    │  │ HSTS header             │ │
    │  │ security headers        │ │
    │  │ autoindex on            │ │
    │  │ autoindex_format html   │ │
    │  │ sendfile/tcp_nopush     │ │
    │  │ access/error logs       │ │
    │  │ [bandwidth if enabled]  │ │
    │  │   bandwidth_config      │ │
    │  │   limit_rate directive  │ │
    │  └─────────────────────────┘ │
    │  nginx -t + reload           │
    └──────────────────────────────┘
                    │
    ┌──────────────────────────────┐
    │  setup_bandwidth_limiting()  │  ← only if enabled
    │  /usr/local/bin/             │
    │    nginx-bandwidth-limiter.sh│
    │  /etc/cron.d/                │
    │    nginx-bandwidth-limiter   │
    │  (every 5 min + monthly reset│
    └──────────────────────────────┘
                    │
    ┌──────────────────────────────┐
    │  setup_auto_renewal()        │
    │  check systemctl timer OR    │
    │  /etc/cron.d/certbot         │
    │  create if missing:          │
    │  0 0,12 * * * certbot renew  │
    │  certbot renew --dry-run     │
    └──────────────────────────────┘
                    │
    ┌──────────────────────────────┐
    │  display_setup_summary()     │
    │  finalize_log()              │
    └──────────────────────────────┘
══════════════════════════════════════════════════════════
[3] run_remove()
══════════════════════════════════════════════════════════

    ┌─────────────────────────────┐
    │  list_domains()             │
    │  none? → return to menu     │
    └─────────────────────────────┘
                    │
    ┌─────────────────────────────┐
    │  get_domain_to_remove()     │
    │  prompt → validate exists   │
    │  in sites-available         │
    └─────────────────────────────┘
                    │
    ┌─────────────────────────────┐
    │  gather_domain_info()       │
    │  extract FILES_DIR          │
    │  detect HAS_SSL             │
    │  detect HAS_BANDWIDTH_LIMIT │
    └─────────────────────────────┘
                    │
    ┌─────────────────────────────┐
    │  confirm_removal()          │
    │  show what will be deleted  │
    │  if FILES_DIR exists:       │
    │   prompt delete files? y/n  │
    │  user must TYPE domain name │
    │  to confirm (safety check)  │
    │  cancel → return to menu    │
    └─────────────────────────────┘
                    │ confirmed
    ┌─────────────────────────────┐
    │  remove_nginx_config()      │
    │  rm sites-enabled symlink   │
    │  rm sites-available config  │
    │  nginx -t + reload          │
    └─────────────────────────────┘
                    │
    ┌─────────────────────────────┐
    │  remove_ssl_certificate()   │
    │  HAS_SSL? no → skip         │
    │  certbot delete --cert-name │
    │  fail → manual rm:          │
    │   /etc/letsencrypt/live/    │
    │   /etc/letsencrypt/archive/ │
    │   /etc/letsencrypt/renewal/ │
    └─────────────────────────────┘
                    │
    ┌─────────────────────────────┐
    │  remove_bandwidth_limiting()│
    │  rm domain bandwidth map    │
    │  rm bandwidth log           │
    │  last domain with BW limit? │
    │  yes → prompt rm global     │
    │         script + cron       │
    └─────────────────────────────┘
                    │
    ┌─────────────────────────────┐
    │  remove_log_files()         │
    │  rm /var/log/nginx/$DOMAIN- │
    │     access.log / error.log  │
    └─────────────────────────────┘
                    │
    ┌─────────────────────────────┐
    │  remove_files_directory()   │
    │  DELETE_FILES=="yes"?       │
    │  yes → final confirmation   │
    │         rm -rf FILES_DIR    │
    │  no  → preserve files       │
    └─────────────────────────────┘
                    │
    display_removal_summary()
    finalize_log()
══════════════════════════════════════════════════════════
[5] run_limit_rate()  —  Submenu loop
══════════════════════════════════════════════════════════

    ┌──────────────────────────────────────────────────────────┐
    │  show_current_restrictions()  (displayed each iteration) │
    │  default rate / per-IP rules / per-domain directives     │
    │                                                          │
    │  1) Set per-IP speed cap    2) Set global default rate   │
    │  3) Enable for a domain     0) Back                      │
    └──────────────────────────────────────────────────────────┘
         │                     │                    │
   [1] _limit_rate_set_ip()  [2] _limit_rate_set_default()  [3] _limit_rate_enable_for_domain()
         │                     │                    │
   ensure_geo_conf()        ensure_geo_conf()    list domains
   read IP + rate           read rate            user selects
   convert to bytes/s       (empty=unlimited)    sed inject:
   update IP_LIMITS_CONF    update default       autoindex_format html;
   inject_rate_limit_to_    value in geo conf    → + limit_rate $grin_rate_limit;
   sites() → all configs    inject_rate_limit_   nginx -t + reload
   nginx -t + reload        to_sites()
                            nginx -t + reload

══════════════════════════════════════════════════════════
[6] run_lift_rate()  —  Submenu
══════════════════════════════════════════════════════════

    1) Lift specific IP limit  → sed remove from IP_LIMITS_CONF; reload
    2) Lift ALL IP limits      → reset geo conf to default 0; reload
    3) Remove from domain      → sed remove limit_rate directive; reload
    0) Cancel

══════════════════════════════════════════════════════════
[7] run_enhance_security()  —  fail2ban Setup
══════════════════════════════════════════════════════════

    Step 1: apt/yum install fail2ban
    Step 2: create /etc/nginx/conf.d/grin_limit_req.conf
            └─ limit_req_zone  $binary_remote_addr  zone=grin_req:10m  rate=20r/s
            └─ limit_req_status 429
    Step 3: inject into all site configs
            └─ sed: after autoindex_format html; add limit_req zone=grin_req burst=30 nodelay
    Step 4: create /etc/fail2ban/jail.d/nginx-grin.conf
            ├─ [nginx-http-auth]   bantime=3600  findtime=600  maxretry=3
            ├─ [nginx-limit-req]   bantime=600   findtime=60   maxretry=10
            └─ [nginx-botsearch]   maxretry=2
    Step 5: systemctl enable + restart fail2ban
    Step 6: nginx -t + reload

══════════════════════════════════════════════════════════
[8] run_fail2ban_management()  —  Submenu loop
══════════════════════════════════════════════════════════

    guard: fail2ban-client installed? no → error + return

    A) Overall status   → fail2ban-client status (all jails) → save to log
    B) nginx-http-auth  → fail2ban-client status nginx-http-auth → save to log
    C) Unban IP         → read IP → fail2ban-client set nginx-http-auth unbanip $IP
    D) List banned      → fail2ban-client get nginx-http-auth banned (top 50) → save to log
    0) Back

══════════════════════════════════════════════════════════
[9] run_ip_filtering()  —  Submenu loop
══════════════════════════════════════════════════════════

    init_security_dirs()   → /etc/grin-toolkit/ + blocked_ips.list
    detect_firewall()      → ufw or iptables

    1) Block IP/CIDR   → _ip_block()
                          read IP + reason
                          ufw deny IP  OR  iptables -I DROP
                          log to blocked_ips.list

    2) Unblock IP      → _ip_unblock()
                          read IP
                          ufw delete deny  OR  iptables -D
                          sed remove from blocked_ips.list

    3) List blocked    → _ip_list()
                          cat blocked_ips.list
                          iptables -L INPUT grep DROP

    0) Back
Key design patterns in script 02:

Two setup paths (Grin vs Custom) share the same pipeline — only domain validation differs (strict prefix check vs any domain)
nginx lifecycle: HTTP-only → certbot patches → full HTTPS rewrite with security headers — config is written twice (once for HTTP challenge, once for final HTTPS)
Bandwidth limiting is a post-setup concern: cron-based script tracks per-domain transfer and degrades speed after quota
Rate limiting has two layers: nginx limit_rate (byte speed) and fail2ban limit_req_zone (request rate) — set up separately via options 5/7
Domain removal requires typing the domain name as a safety confirmation — similar to how GitHub asks you to type the repo name before deletion
