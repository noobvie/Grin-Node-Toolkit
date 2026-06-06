class PoolSettings {
  constructor(db) {
    this.db = db;
  }

  // Default values for each configuration section
  static defaults = {
    pool_info: {
      pool_name: 'GRINIUM',
      pool_tagline: 'Grin Mining Pool',
      pool_description: '',
      pool_visibility: 'public',
      address_whitelist: '[]',
      mining_mode: 'stratum',
      pool_fee_percent: 2.0,
      max_miners: 0,
      contact_email: '',
      homepage_banner: '',
    },
    branding: {
      logo_file: '',
      favicon_file: '',
      accent_color: '#667eea',
      pool_theme: 'dark',
      custom_css: '',
      discord_link: '',
      telegram_link: '',
      twitter_link: '',
      website_link: '',
      footer_text: '',
    },
    seo: {
      meta_description: '',
      meta_keywords: '',
      og_title: '',
      og_description: '',
      og_image_file: '',
      ga_tracking_id: '',
      site_url: '',
      sitemap_enabled: 'true',
      robots_noindex: 'false',
    },
    payout: {
      min_withdrawal: 0.1,
      auto_payout: 'false',
      payout_frequency: 'manual',
      confirm_depth_mainnet: 1441,
      confirm_depth_testnet: 100,
      max_pending_withdrawals: 100,
      max_user_pending: 10,
      withdrawal_retry_delays: '[21600,43200,86400,172800]',
    },
    access: {
      admin_ip_allowlist: '[]',
      admin_ip_blacklist: '[]',
      session_timeout_hours: 1,
      invite_codes_enabled: 'false',
      invite_codes: '[]',
    },
    alerts: {
      alert_check_interval_secs: 60,
      alert_email_address: '',
      discord_webhook_url: '',
      slack_webhook_url: '',
      alert_large_withdrawal: 100,
      alert_tor_fails_per_week: 3,
      alert_thresholds: '{"wallet_balance_warning_grin":10,"rejection_rate_warning_percent":20,"error_rate_warning_percent":50,"difficulty_change_warning_percent":50}',
    },
  };

  // Validation rules per section
  static validators = {
    pool_info: {
      pool_fee_percent: (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0 || n > 50) throw new Error('pool_fee_percent must be 0-50');
        return n;
      },
      pool_visibility: (val) => {
        if (!['public', 'private', 'maintenance'].includes(val)) throw new Error('invalid pool_visibility');
        return val;
      },
      mining_mode: (val) => {
        if (!['stratum', 'solo'].includes(val)) throw new Error('invalid mining_mode');
        return val;
      },
      max_miners: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0) throw new Error('max_miners must be >= 0');
        return n;
      },
    },
    branding: {
      accent_color: (val) => {
        if (!/^#[0-9a-fA-F]{6}$/.test(val)) throw new Error('accent_color must be valid hex (#xxxxxx)');
        return val;
      },
    },
    seo: {
      ga_tracking_id: (val) => {
        if (val && !/^G-[A-Z0-9]+$/.test(val)) throw new Error('invalid GA tracking ID format');
        return val;
      },
      site_url: (val) => {
        if (val) {
          try {
            new URL(val);
          } catch (err) {
            throw new Error('site_url must be a valid URL');
          }
        }
        return val;
      },
    },
    payout: {
      min_withdrawal: (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n <= 0) throw new Error('min_withdrawal must be > 0');
        return n;
      },
      payout_frequency: (val) => {
        if (!['manual', 'hourly', 'daily', 'weekly'].includes(val)) throw new Error('invalid payout_frequency');
        return val;
      },
    },
    access: {
      session_timeout_hours: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1 || n > 168) throw new Error('session_timeout_hours must be 1-168');
        return n;
      },
    },
    alerts: {
      alert_check_interval_secs: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 5 || n > 3600) throw new Error('alert_check_interval_secs must be 5-3600');
        return n;
      },
    },
  };

  getSection(section) {
    if (!PoolSettings.defaults[section]) {
      throw new Error(`Unknown section: ${section}`);
    }

    const defaults = { ...PoolSettings.defaults[section] };
    const stmt = this.db.prepare('SELECT key, value, value_type FROM pool_config WHERE section = ?');
    const rows = stmt.all(section);

    for (const row of rows) {
      if (row.value_type === 'number') {
        defaults[row.key] = parseFloat(row.value);
      } else if (row.value_type === 'boolean') {
        defaults[row.key] = row.value === 'true';
      } else if (row.value_type === 'json') {
        defaults[row.key] = JSON.parse(row.value);
      } else {
        defaults[row.key] = row.value;
      }
    }

    return defaults;
  }

  getAll() {
    const result = {};
    for (const section of Object.keys(PoolSettings.defaults)) {
      result[section] = this.getSection(section);
    }
    return result;
  }

  updateSection(section, values, userId = null) {
    if (!PoolSettings.defaults[section]) {
      throw new Error(`Unknown section: ${section}`);
    }

    const validators = PoolSettings.validators[section] || {};
    const stmt = this.db.prepare(`
      INSERT INTO pool_config (section, key, value, value_type, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(section, key) DO UPDATE SET
        value = excluded.value,
        value_type = excluded.value_type,
        updated_by = excluded.updated_by,
        updated_at = unixepoch()
    `);

    const transaction = this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in PoolSettings.defaults[section])) {
          throw new Error(`Unknown key '${key}' in section '${section}'`);
        }

        let validated = value;
        if (validators[key]) {
          validated = validators[key](value);
        }

        let valueStr = value;
        let valueType = 'string';

        if (typeof validated === 'number') {
          valueStr = validated.toString();
          valueType = 'number';
        } else if (typeof validated === 'boolean') {
          valueStr = validated ? 'true' : 'false';
          valueType = 'boolean';
        } else if (typeof validated === 'object') {
          valueStr = JSON.stringify(validated);
          valueType = 'json';
        } else if (validated === null || validated === undefined) {
          valueStr = '';
        }

        stmt.run(section, key, valueStr, valueType, userId);
      }
    });

    transaction();
    return this.getSection(section);
  }

  resetSection(section, userId = null) {
    if (!PoolSettings.defaults[section]) {
      throw new Error(`Unknown section: ${section}`);
    }

    const stmt = this.db.prepare('DELETE FROM pool_config WHERE section = ?');
    stmt.run(section);

    const auditStmt = this.db.prepare(`
      INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
      VALUES (?, 'reset_settings', 'pool_config', ?, ?)
    `);
    auditStmt.run(userId, section, JSON.stringify({ section, timestamp: new Date().toISOString() }));

    return this.getSection(section);
  }

  resetAll(userId = null) {
    const stmt = this.db.prepare('DELETE FROM pool_config');
    stmt.run();

    const auditStmt = this.db.prepare(`
      INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
      VALUES (?, 'reset_all_settings', 'pool_config', 'all', ?)
    `);
    auditStmt.run(userId, JSON.stringify({ timestamp: new Date().toISOString() }));

    return this.getAll();
  }

  // Merge DB settings into a config object (called at startup)
  static applyToConfig(config, allSettings) {
    const { pool_info, payout } = allSettings;

    if (pool_info.pool_fee_percent !== undefined) {
      config.pool_fee_percent = pool_info.pool_fee_percent;
    }
    if (payout.min_withdrawal !== undefined) {
      config.min_withdrawal = payout.min_withdrawal;
    }
    if (payout.max_pending_withdrawals !== undefined) {
      config.max_pending_withdrawals = payout.max_pending_withdrawals;
    }
    if (payout.max_user_pending !== undefined) {
      config.max_user_pending = payout.max_user_pending;
    }
    if (pool_info.pool_name !== undefined) {
      config.pool_name = pool_info.pool_name;
    }

    return config;
  }
}

module.exports = PoolSettings;
