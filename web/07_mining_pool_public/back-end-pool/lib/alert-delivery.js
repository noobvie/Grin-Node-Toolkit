/**
 * Alert Delivery — Send alerts via email, Discord, Slack
 *
 * Handles formatting and delivery of alerts to configured channels.
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

    this.log('Initialized (email, Discord, Slack)');
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

    await Promise.allSettled(promises);
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

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
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
      'connection_surge': 'Connection Surge'
    };
    return names[type] || type;
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
${alert.data ? JSON.stringify(JSON.parse(alert.data), null, 2) : 'No additional data'}

---
Grin Pool Alert Monitor
    `.trim();
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
