<?php
/**
 * Grinpay_Status — prerequisite and runtime health checks.
 *
 * Singleton. Checks PHP / WP / WC versions, bridge/server reachability,
 * and grin node + wallet versions. Returns a structured result array used
 * by the admin status tab and by the gateway to self-disable at checkout.
 */

defined( 'ABSPATH' ) || exit;

class Grinpay_Status {

	private static ?Grinpay_Status $instance = null;

	/** @var array<int, array{id: string, label: string, severity: string, status: string, message: string, detail: string}> */
	private array $last_results = [];

	// ── Singleton ──────────────────────────────────────────────────────────────

	public static function get_instance(): static {
		if ( null === static::$instance ) {
			static::$instance = new static();
		}
		return static::$instance;
	}

	private function __construct() {}

	// ── Public API ─────────────────────────────────────────────────────────────

	/**
	 * Run all checks and return structured results.
	 *
	 * @return array<int, array{id: string, label: string, severity: string, status: string, message: string, detail: string}>
	 */
	public function check_all(): array {
		$results = [];

		// Always-required checks (both connection modes)
		$results[] = $this->check_php();
		$results[] = $this->check_wordpress();
		$results[] = $this->check_woocommerce();
		$results[] = $this->check_wc_block();
		$results[] = $this->check_hpos();
		$results[] = $this->check_php_extensions();

		$mode = $this->get_connection_mode();

		if ( 'grinpay_server' === $mode ) {
			$results[] = $this->check_grinpay_server();
		} else {
			$results[] = $this->check_bridge_config();
			$results[] = $this->check_bridge();
		}

		$this->last_results = $results;
		return $results;
	}

	/**
	 * Returns true if any critical check failed (gateway should self-disable).
	 */
	public function has_critical_failure(): bool {
		if ( empty( $this->last_results ) ) {
			$this->check_all();
		}
		foreach ( $this->last_results as $r ) {
			if ( 'critical' === $r['severity'] && 'fail' === $r['status'] ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get cached results without re-running checks.
	 *
	 * @return array<int, array{id: string, label: string, severity: string, status: string, message: string, detail: string}>
	 */
	public function get_last_results(): array {
		return $this->last_results;
	}

	// ── Individual checks ──────────────────────────────────────────────────────

	private function check_php(): array {
		$current  = PHP_VERSION;
		$required = GRINPAY_MIN_PHP;
		$ok       = version_compare( $current, $required, '>=' );

		return $this->result(
			'php_version',
			__( 'PHP version', 'grinpay-woocommerce' ),
			'critical',
			$ok,
			sprintf(
				/* translators: 1: current version 2: required version */
				$ok
					? __( 'PHP %1$s — OK', 'grinpay-woocommerce' )
					: __( 'PHP %1$s — required >= %2$s. Please upgrade PHP on this server.', 'grinpay-woocommerce' ),
				$current,
				$required
			),
			"required: >= {$required}"
		);
	}

	private function check_wordpress(): array {
		$current  = get_bloginfo( 'version' );
		$required = GRINPAY_MIN_WP;
		$ok       = version_compare( $current, $required, '>=' );

		return $this->result(
			'wp_version',
			__( 'WordPress version', 'grinpay-woocommerce' ),
			'critical',
			$ok,
			sprintf(
				$ok
					? __( 'WordPress %1$s — OK', 'grinpay-woocommerce' )
					: __( 'WordPress %1$s — required >= %2$s.', 'grinpay-woocommerce' ),
				$current,
				$required
			),
			"required: >= {$required}"
		);
	}

	private function check_woocommerce(): array {
		$current  = defined( 'WC_VERSION' ) ? WC_VERSION : '0.0.0';
		$required = GRINPAY_MIN_WC;
		$ok       = class_exists( 'WooCommerce' ) && version_compare( $current, $required, '>=' );

		return $this->result(
			'wc_version',
			__( 'WooCommerce version', 'grinpay-woocommerce' ),
			'critical',
			$ok,
			sprintf(
				$ok
					? __( 'WooCommerce %1$s — OK', 'grinpay-woocommerce' )
					: __( 'WooCommerce %1$s — required >= %2$s.', 'grinpay-woocommerce' ),
				$current,
				$required
			),
			"required: >= {$required}"
		);
	}

	private function check_wc_block(): array {
		$active = class_exists( '\Automattic\WooCommerce\Blocks\Package' );

		return $this->result(
			'wc_block',
			__( 'WC Checkout Block', 'grinpay-woocommerce' ),
			'critical',
			$active,
			$active
				? __( 'Active', 'grinpay-woocommerce' )
				: __( 'WooCommerce Blocks package not found. Ensure WooCommerce 10.6.1+ is active.', 'grinpay-woocommerce' ),
			''
		);
	}

	private function check_hpos(): array {
		$enabled = false;
		if ( class_exists( '\Automattic\WooCommerce\Utilities\OrderUtil' ) ) {
			$enabled = \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
		}

		return $this->result(
			'hpos',
			__( 'WC HPOS', 'grinpay-woocommerce' ),
			'warning',
			$enabled,
			$enabled
				? __( 'Enabled', 'grinpay-woocommerce' )
				: __( 'HPOS is not enabled. GrinPay works but HPOS is recommended for new stores.', 'grinpay-woocommerce' ),
			''
		);
	}

	private function check_php_extensions(): array {
		$missing = [];
		foreach ( [ 'curl', 'json' ] as $ext ) {
			if ( ! extension_loaded( $ext ) ) {
				$missing[] = $ext;
			}
		}
		$ok = empty( $missing );

		return $this->result(
			'php_extensions',
			__( 'PHP extensions (curl, json)', 'grinpay-woocommerce' ),
			'critical',
			$ok,
			$ok
				? __( 'curl, json — enabled', 'grinpay-woocommerce' )
				: sprintf(
					/* translators: 1: comma-separated list of missing extensions */
					__( 'Missing PHP extensions: %1$s', 'grinpay-woocommerce' ),
					implode( ', ', $missing )
				),
			''
		);
	}

	private function check_bridge_config(): array {
		$config_file = GRINPAY_PLUGIN_DIR . 'bridge-config.php';
		$ok          = file_exists( $config_file );

		return $this->result(
			'bridge_config',
			__( 'bridge-config.php', 'grinpay-woocommerce' ),
			'critical',
			$ok,
			$ok
				? __( 'Present', 'grinpay-woocommerce' )
				: __( 'bridge-config.php not found. Run the Grin Node Toolkit script 053 option 2 to install the plugin properly.', 'grinpay-woocommerce' ),
			GRINPAY_PLUGIN_DIR . 'bridge-config.php'
		);
	}

	private function check_bridge(): array {
		$bridge_url = $this->get_bridge_url();

		if ( empty( $bridge_url ) ) {
			return $this->result(
				'bridge',
				__( 'Bridge', 'grinpay-woocommerce' ),
				'critical',
				false,
				__( 'Bridge URL not configured. Check network/connection mode settings.', 'grinpay-woocommerce' ),
				''
			);
		}

		$start    = microtime( true );
		$response = wp_remote_get(
			trailingslashit( $bridge_url ) . 'api/status',
			[
				'timeout'   => 5,
				'sslverify' => false,
			]
		);
		$elapsed_ms = (int) round( ( microtime( true ) - $start ) * 1000 );

		if ( is_wp_error( $response ) ) {
			return $this->result(
				'bridge',
				__( 'Bridge', 'grinpay-woocommerce' ),
				'critical',
				false,
				sprintf(
					/* translators: 1: bridge URL 2: error message */
					__( 'Connection refused (%1$s) — %2$s. Fix: sudo systemctl start grin-woo-bridge-test', 'grinpay-woocommerce' ),
					$bridge_url,
					$response->get_error_message()
				),
				$bridge_url
			);
		}

		$code = wp_remote_retrieve_response_code( $response );
		if ( 200 !== (int) $code ) {
			return $this->result(
				'bridge',
				__( 'Bridge', 'grinpay-woocommerce' ),
				'critical',
				false,
				sprintf(
					/* translators: 1: HTTP status code */
					__( 'Bridge returned HTTP %1$s.', 'grinpay-woocommerce' ),
					$code
				),
				$bridge_url
			);
		}

		$body = json_decode( wp_remote_retrieve_body( $response ), true );
		$ok   = is_array( $body );

		// Append grin node + wallet version checks from bridge response
		if ( $ok ) {
			$this->last_results[] = $this->check_version_from_response(
				$body,
				'node_version',
				__( 'grin node version', 'grinpay-woocommerce' ),
				'node_version',
				GRINPAY_MIN_NODE
			);
			$this->last_results[] = $this->check_version_from_response(
				$body,
				'wallet_version',
				__( 'grin-wallet version', 'grinpay-woocommerce' ),
				'wallet_version',
				GRINPAY_MIN_WALLET
			);
			$this->last_results[] = $this->check_version_from_response(
				$body,
				'python_version',
				__( 'Python version', 'grinpay-woocommerce' ),
				'python_version',
				GRINPAY_MIN_PYTHON
			);
		}

		$network = isset( $body['network'] ) ? strtoupper( (string) $body['network'] ) : '?';
		$balance = isset( $body['balance'] ) ? number_format( (float) $body['balance'], 9 ) . ' GRIN' : '?';

		return $this->result(
			'bridge',
			__( 'Bridge', 'grinpay-woocommerce' ),
			'critical',
			$ok,
			sprintf(
				/* translators: 1: response time in ms 2: network name 3: balance */
				__( 'Responded in %1$dms — network: %2$s — balance: %3$s', 'grinpay-woocommerce' ),
				$elapsed_ms,
				$network,
				$balance
			),
			$bridge_url
		);
	}

	private function check_grinpay_server(): array {
		$gateway    = $this->get_gateway_instance();
		$server_url = $gateway ? $gateway->get_option( 'server_url' ) : '';
		$api_key    = $gateway ? $gateway->get_option( 'api_key' ) : '';

		if ( empty( $server_url ) ) {
			return $this->result(
				'grinpay_server',
				__( 'GrinPay Server', 'grinpay-woocommerce' ),
				'critical',
				false,
				__( 'Server URL not configured.', 'grinpay-woocommerce' ),
				''
			);
		}

		$start    = microtime( true );
		$response = wp_remote_get(
			trailingslashit( $server_url ) . 'api/status',
			[
				'timeout'   => 5,
				'sslverify' => true,
				'headers'   => [ 'X-Api-Key' => $api_key ],
			]
		);
		$elapsed_ms = (int) round( ( microtime( true ) - $start ) * 1000 );

		if ( is_wp_error( $response ) ) {
			return $this->result(
				'grinpay_server',
				__( 'GrinPay Server', 'grinpay-woocommerce' ),
				'critical',
				false,
				sprintf(
					/* translators: 1: server URL 2: error message */
					__( 'Connection refused (%1$s) — %2$s', 'grinpay-woocommerce' ),
					$server_url,
					$response->get_error_message()
				),
				$server_url
			);
		}

		$code = wp_remote_retrieve_response_code( $response );

		if ( 401 === (int) $code ) {
			return $this->result(
				'grinpay_server',
				__( 'GrinPay Server', 'grinpay-woocommerce' ),
				'critical',
				false,
				__( '401 Unauthorized — invalid or expired API key. Generate a new key in GrinPay Server admin.', 'grinpay-woocommerce' ),
				$server_url
			);
		}

		if ( 200 !== (int) $code ) {
			return $this->result(
				'grinpay_server',
				__( 'GrinPay Server', 'grinpay-woocommerce' ),
				'critical',
				false,
				sprintf(
					/* translators: 1: HTTP status code */
					__( 'Server returned HTTP %1$s.', 'grinpay-woocommerce' ),
					$code
				),
				$server_url
			);
		}

		$body    = json_decode( wp_remote_retrieve_body( $response ), true );
		$ok      = is_array( $body );
		$version = $body['version'] ?? '?';
		$network = isset( $body['network'] ) ? strtoupper( (string) $body['network'] ) : '?';
		$balance = isset( $body['balance'] ) ? number_format( (float) $body['balance'], 9 ) . ' GRIN' : '?';

		return $this->result(
			'grinpay_server',
			__( 'GrinPay Server', 'grinpay-woocommerce' ),
			'critical',
			$ok,
			sprintf(
				/* translators: 1: response time 2: server version 3: network 4: balance */
				__( 'Responded in %1$dms — v%2$s — network: %3$s — balance: %4$s', 'grinpay-woocommerce' ),
				$elapsed_ms,
				$version,
				$network,
				$balance
			),
			$server_url
		);
	}

	// ── Helpers ────────────────────────────────────────────────────────────────

	/**
	 * @param array<string, mixed> $body
	 */
	private function check_version_from_response(
		array $body,
		string $id,
		string $label,
		string $key,
		string $required
	): array {
		$current = isset( $body[ $key ] ) ? (string) $body[ $key ] : '';

		if ( '' === $current ) {
			return $this->result( $id, $label, 'warning', false, __( 'Not reported by bridge.', 'grinpay-woocommerce' ), '' );
		}

		// Strip leading 'v' if present
		$current_clean = ltrim( $current, 'v' );
		$ok            = version_compare( $current_clean, $required, '>=' );

		return $this->result(
			$id,
			$label,
			'critical',
			$ok,
			sprintf(
				$ok
					? /* translators: 1: version */ __( '%1$s — OK', 'grinpay-woocommerce' )
					: /* translators: 1: current 2: required */ __( '%1$s — required >= %2$s', 'grinpay-woocommerce' ),
				$current,
				$required
			),
			"required: >= {$required}"
		);
	}

	/**
	 * Build a standard result entry.
	 *
	 * @return array{id: string, label: string, severity: string, status: string, message: string, detail: string}
	 */
	private function result(
		string $id,
		string $label,
		string $severity,
		bool $ok,
		string $message,
		string $detail
	): array {
		return [
			'id'       => $id,
			'label'    => $label,
			'severity' => $severity,        // 'critical' | 'warning'
			'status'   => $ok ? 'ok' : 'fail',
			'message'  => $message,
			'detail'   => $detail,
		];
	}

	private function get_connection_mode(): string {
		$gateway = $this->get_gateway_instance();
		return $gateway ? (string) $gateway->get_option( 'connection_mode', 'self_hosted' ) : 'self_hosted';
	}

	private function get_bridge_url(): string {
		$gateway = $this->get_gateway_instance();
		if ( ! $gateway ) {
			// Fallback: try bridge-config.php
			$config = GRINPAY_PLUGIN_DIR . 'bridge-config.php';
			if ( file_exists( $config ) ) {
				require_once $config;
				return defined( 'GRINPAY_BRIDGE_URL' ) ? GRINPAY_BRIDGE_URL : '';
			}
			return '';
		}
		return $gateway->get_bridge_url();
	}

	private function get_gateway_instance(): ?Grinpay_Gateway {
		if ( ! class_exists( 'Grinpay_Gateway' ) ) {
			return null;
		}
		$gateways = WC()->payment_gateways();
		if ( ! $gateways ) {
			return null;
		}
		$all = $gateways->payment_gateways();
		return isset( $all['grinpay'] ) && $all['grinpay'] instanceof Grinpay_Gateway
			? $all['grinpay']
			: null;
	}
}
