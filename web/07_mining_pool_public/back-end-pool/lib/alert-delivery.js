/**
 * Alert Delivery — Send alerts via email (SMTP), Discord, Slack and Telegram.
 *
 * Handles formatting and delivery of alerts to whichever channels are configured
 * (see configuredChannels() — a channel with no config is silently skipped).
 */

const https = require('https');
const { URL } = require('url');

class AlertDelivery {
  constructor(config) {
    this.config = config;
    this.smtpConfig = config.smtp || {};
    this.discordWebhook = config.discord_webhook_url;
    this.slackWebhook = config.slack_webhook_url;
    this.alertEmail = config.alert_email_address;
    // Telegram: bot token (from @BotFather) + chat id (a user, group, or channel id).
    // Both must be set for delivery; the bot must have been started by / added to the chat.
    this.telegramBotToken = config.telegram_bot_token;
    this.telegramChatId = config.telegram_chat_id;

    this.log('Initialized (email, Discord, Slack, Telegram)');
  }

  // Which channels are configured — surfaced to the admin panel so the operator can see
  // at a glance what a test/alert will actually reach.
  configuredChannels() {
    return {
      email: !!(this.alertEmail && this.smtpConfig.enabled),
      discord: !!this.discordWebhook,
      slack: !!this.slackWebhook,
      telegram: !!(this.telegramBotToken && this.telegramChatId),
    };
  }

  /**
   * Send alert via all configured channels
   */
  async send(alert) {
    const promises = [];

    if (this.alertEmail && this.smtpConfig.enabled) {
      promises.push(this.sendEmail(alert).catch(err =>
        this.error(`Email delivery failed: ${err.message}`)
      ));
    }

    if (this.discordWebhook) {
      promises.push(this.sendDiscord(alert).catch(err =>
        this.error(`Discord delivery failed: ${err.message}`)
      ));
    }

    if (this.slackWebhook) {
      promises.push(this.sendSlack(alert).catch(err =>
        this.error(`Slack delivery failed: ${err.message}`)
      ));
    }

    if (this.telegramBotToken && this.telegramChatId) {
      promises.push(this.sendTelegram(alert).catch(err =>
        this.error(`Telegram delivery failed: ${err.message}`)
      ));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Send alert to Telegram via the Bot API (sendMessage). HTML parse mode.
   */
  async sendTelegram(alert) {
    const emoji = { critical: '🔴', warning: '🟡', info: '🔵' }[alert.level] || '⚪';
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text =
      `${emoji} <b>${esc(this.formatAlertType(alert.type))}</b>\n` +
      `${esc(alert.message)}\n\n` +
      `Level: <b>${esc(alert.level.toUpperCase())}</b>  ·  Occurrences: ${alert.occurrence_count}\n` +
      `${new Date(alert.triggered_at).toISOString()}`;

    const url = new URL(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`);
    const payload = JSON.stringify({
      chat_id: this.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return this.postWebhook(url, payload);
  }

  /**
   * Send alert via email (SMTP)
   */
  async sendEmail(alert) {
    if (!this.smtpConfig.enabled || !this.alertEmail) {
      return;
    }

    // nodemailer is an optional dependency: lazy-require so a deployment that hasn't
    // installed it (or has email disabled) degrades gracefully instead of crashing at boot.
    let nodemailer;
    try {
      nodemailer = require('nodemailer');
    } catch (e) {
      this.log('Email delivery skipped: nodemailer not installed (run npm install)');
      return;
    }

    const subject = `[${alert.level.toUpperCase()}] ${this.formatAlertType(alert.type)}`;
    const body = this.formatEmailBody(alert);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // smtpConfig is passed straight to nodemailer (host, port, secure, auth:{user,pass}, …).
    const transporter = nodemailer.createTransport(this.smtpConfig);
    await transporter.sendMail({
      from: this.smtpConfig.from || this.alertEmail,
      to: this.alertEmail,
      subject,
      text: body,
      html: `<pre>${esc(body)}</pre>`
    });

    this.log(`Alert email sent to ${this.alertEmail}: ${subject}`);
  }

  /**
   * Send alert to Discord webhook
   */
  async sendDiscord(alert) {
    const url = new URL(this.discordWebhook);

    // Format message
    const color = {
      critical: 16711680, // Red
      warning: 16776960,  // Yellow
      info: 3066993       // Blue
    }[alert.level] || 9807270; // Default gray

    const embed = {
      title: this.formatAlertType(alert.type),
      description: alert.message,
      color,
      fields: [
        { name: 'Level', value: alert.level.toUpperCase(), inline: true },
        { name: 'Count', value: alert.occurrence_count.toString(), inline: true },
        { name: 'Triggered', value: new Date(alert.triggered_at).toISOString(), inline: false }
      ],
      footer: { text: 'Grin Pool Alert Monitor' },
      timestamp: new Date().toISOString()
    };

    const payload = JSON.stringify({
      embeds: [embed]
    });

    return this.postWebhook(url, payload);
  }

  /**
   * Send alert to Slack webhook
   */
  async sendSlack(alert) {
    const url = new URL(this.slackWebhook);

    // Format message
    const color = {
      critical: 'danger',
      warning: 'warning',
      info: 'good'
    }[alert.level] || '#808080';

    const payload = JSON.stringify({
      attachments: [
        {
          title: this.formatAlertType(alert.type),
          text: alert.message,
          color,
          fields: [
            { title: 'Level', value: alert.level.toUpperCase(), short: true },
            { title: 'Occurrences', value: alert.occurrence_count.toString(), short: true },
            { title: 'Triggered', value: new Date(alert.triggered_at).toISOString(), short: false }
          ],
          footer: 'Grin Pool Alert Monitor',
          ts: Math.floor(new Date(alert.triggered_at).getTime() / 1000)
        }
      ]
    });

    return this.postWebhook(url, payload);
  }

  /**
   * POST to webhook URL (Discord, Slack)
   */
  postWebhook(url, payload) {
    return new Promise((resolve, reject) => {
      // The scheme was never checked. `new URL('http://internal/x')` parses fine and
      // https.request then dialled internal:443 with TLS regardless — so an operator who
      // pasted an http:// webhook got a silent, confusing TLS attempt rather than an
      // error naming the real problem. Refuse anything but https up front.
      // Audit §J13-2 / §J13-3.
      if (url.protocol !== 'https:') {
        reject(new Error(`webhook URL must use https (got ${url.protocol})`));
        return;
      }
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'GrinPoolAlerts/1.0'
        },
        timeout: 10000
      };

      // Response cap. `timeout` here is a socket INACTIVITY timer, so a server that drips
      // a byte every 9 s never trips it while `data` grows without bound. 64 KB is far more
      // than any webhook ack.
      const MAX_RESPONSE_BYTES = 65536;
      const req = https.request(options, (res) => {
        let data = '';
        let bytes = 0;
        let overflowed = false;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            if (!overflowed) {
              overflowed = true;
              req.destroy();
              reject(new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            }
            return;
          }
          data += chunk;
        });
        res.on('end', () => {
          if (overflowed) return;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.on('error', reject);

      req.write(payload);
      req.end();
    });
  }

  /**
   * Format alert type for display
   */
  formatAlertType(type) {
    const names = {
      'node_down': 'Node Offline',
      'wallet_offline': 'Wallet Offline',
      'wallet_balance_low': 'Wallet Balance Low',
      'block_orphaned': 'Orphaned Block',
      'payout_failed': 'Payout Failed',
      'high_rejection_rate': 'High Rejection Rate',
      'high_error_rate': 'High Error Rate',
      'tor_unreachable': 'Tor Unreachable',
      'difficulty_spike': 'Difficulty Spike',
      'connection_surge': 'Connection Surge',
      // Money-integrity detectors (AlertMonitor). Added here 2026-08-22: this map was
      // written before they existed, so the seven alerts that can FREEZE PAYOUTS were the
      // only ones arriving as raw snake_case — "coverage_shortfall" in the email subject
      // line, next to properly named cosmetic ones like "Difficulty Spike".
      'coverage_shortfall': 'Coverage Shortfall',
      'ledger_integrity_drift': 'Ledger Integrity Drift',
      'wallet_drain': 'Wallet Drain',
      'unrecorded_wallet_send': 'Unrecorded Wallet Send',
      'large_withdrawal': 'Large Withdrawal',
      'payout_surge': 'Payout Surge',
      'wallet_identity_changed': 'Wallet Identity Changed'
    };
    // Fall back to Title Case rather than the raw key, so the next detector added without
    // touching this map degrades to "New Detector" instead of "new_detector".
    return names[type] || String(type).replace(/_/g, ' ').replace(/(^| )\w/g, c => c.toUpperCase());
  }

  /**
   * Format email body
   */
  formatEmailBody(alert) {
    return `
Pool Alert
===========
Type: ${this.formatAlertType(alert.type)}
Level: ${alert.level.toUpperCase()}
Message: ${alert.message}
Triggered: ${new Date(alert.triggered_at).toISOString()}
Occurrences: ${alert.occurrence_count}

Details:
${this.formatAlertData(alert.data)}

---
Grin Pool Alert Monitor
    `.trim();
  }

  /**
   * Pretty-print alert.data, which is a JSON string written by AlertMonitor.
   *
   * Guarded: this used to be a bare JSON.parse inside the template literal, so a row whose
   * data was truncated or non-JSON threw from formatEmailBody → sendEmail → the .catch() in
   * send(), and the alert was dropped with only a delivery-failure line to show for it.
   * Losing a critical money alert to a formatting error is the wrong trade — show the raw
   * string instead.
   */
  formatAlertData(data) {
    if (!data) return 'No additional data';
    try {
      return JSON.stringify(JSON.parse(data), null, 2);
    } catch (e) {
      return String(data);
    }
  }

  log(msg) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [AlertDelivery] ${msg}`);
  }

  error(msg) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [AlertDelivery] ERROR: ${msg}`);
  }
}

module.exports = AlertDelivery;
