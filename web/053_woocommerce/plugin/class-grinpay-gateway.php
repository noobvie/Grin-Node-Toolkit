<?php
/**
 * Grinpay_Gateway — WooCommerce payment gateway for Grin.
 *
 * Extends WC_Payment_Gateway. All order meta uses HPOS-safe CRUD methods.
 * All method signatures use explicit nullable types (PHP 8.4 safe).
 */

defined( 'ABSPATH' ) || exit;

class Grinpay_Gateway extends WC_Payment_Gateway {

	/** Gateway ID used by WooCommerce internally. */
	public string $id = 'grinpay';

	// ── Constructor ────────────────────────────────────────────────────────────

	public function __construct() {
		$this->id                 = 'grinpay';
		$this->method_title       = __( 'GrinPay', 'grinpay-woocommerce' );
		$this->method_description = __( 'Accept Grin (GRIN) payments via Slatepack interactive transactions.', 'grinpay-woocommerce' );
		$this->has_fields         = false;
		$this->supports           = [ 'products' ];

		$this->init_form_fields();
		$this->init_settings();

		// Read settings
		$this->title       = $this->get_option( 'title', __( 'Grin (GRIN)', 'grinpay-woocommerce' ) );
		$this->description = $this->get_option( 'description', __( 'Pay privately with Grin. A grin-wallet is required to complete payment after checkout.', 'grinpay-woocommerce' ) );

		// Load bridge-config.php defaults only if settings are not yet saved
		$this->maybe_load_bridge_config();

		// Save settings hook
		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, [ $this, 'process_admin_options' ] );

		// Thank-you page hook (fires inside WC thank-you template — theme-agnostic)
		add_action( 'woocommerce_thankyou_' . $this->id, [ $this, 'render_thankyou_page' ] );

		// AJAX handlers
		add_action( 'wp_ajax_grinpay_submit_response',        [ $this, 'ajax_submit_response' ] );
		add_action( 'wp_ajax_nopriv_grinpay_submit_response', [ $this, 'ajax_submit_response' ] );

		add_action( 'wp_ajax_grinpay_poll_status',        [ $this, 'ajax_poll_status' ] );
		add_action( 'wp_ajax_nopriv_grinpay_poll_status', [ $this, 'ajax_poll_status' ] );
	}

	// ── Settings fields ────────────────────────────────────────────────────────

	public function init_form_fields(): void {
		// Settings are rendered by class-grinpay-admin.php tabs.
		// WooCommerce still needs form_fields defined so process_admin_options works.
		$this->form_fields = [
			'enabled' => [
				'title'   => __( 'Enable / Disable', 'grinpay-woocommerce' ),
				'type'    => 'checkbox',
				'label'   => __( 'Enable GrinPay for WooCommerce', 'grinpay-woocommerce' ),
				'default' => 'no',
			],
			'title' => [
				'title'   => __( 'Title', 'grinpay-woocommerce' ),
				'type'    => 'text',
				'default' => __( 'Grin (GRIN)', 'grinpay-woocommerce' ),
			],
			'description' => [
				'title'   => __( 'Description', 'grinpay-woocommerce' ),
				'type'    => 'textarea',
				'default' => __( 'Pay privately with Grin. A grin-wallet is required to complete payment after checkout.', 'grinpay-woocommerce' ),
			],
			'connection_mode' => [
				'title'   => __( 'Connection Mode', 'grinpay-woocommerce' ),
				'type'    => 'select',
				'options' => [
					'self_hosted'    => __( 'Self-hosted (local node + bridge)', 'grinpay-woocommerce' ),
					'grinpay_server' => __( 'GrinPay Server', 'grinpay-woocommerce' ),
				],
				'default' => 'self_hosted',
			],
			'network' => [
				'title'   => __( 'Network', 'grinpay-woocommerce' ),
				'type'    => 'select',
				'options' => [
					'testnet' => __( 'Testnet (tGRIN — for testing)', 'grinpay-woocommerce' ),
					'mainnet' => __( 'Mainnet (real GRIN)', 'grinpay-woocommerce' ),
				],
				'default' => 'testnet',
			],
			'server_url' => [
				'title'   => __( 'GrinPay Server URL', 'grinpay-woocommerce' ),
				'type'    => 'text',
				'default' => '',
			],
			'api_key' => [
				'title'   => __( 'API Key', 'grinpay-woocommerce' ),
				'type'    => 'password',
				'default' => '',
			],
			'expiry_minutes' => [
				'title'   => __( 'Invoice Expiry (minutes)', 'grinpay-woocommerce' ),
				'type'    => 'number',
				'default' => '30',
			],
			'confirmations' => [
				'title'   => __( 'Confirmations Required', 'grinpay-woocommerce' ),
				'type'    => 'number',
				'default' => '1',
			],
			'debug' => [
				'title'   => __( 'Debug Logging', 'grinpay-woocommerce' ),
				'type'    => 'checkbox',
				'label'   => __( 'Enable debug log', 'grinpay-woocommerce' ),
				'default' => 'no',
			],
		];
	}

	// ── Bridge URL helper ──────────────────────────────────────────────────────

	/**
	 * Return the effective bridge/server URL for the current connection mode + network.
	 */
	public function get_bridge_url(): string {
		$mode = $this->get_option( 'connection_mode', 'self_hosted' );

		if ( 'grinpay_server' === $mode ) {
			return rtrim( (string) $this->get_option( 'server_url', '' ), '/' );
		}

		// Self-hosted: derive from network
		$network = $this->get_option( 'network', 'testnet' );
		return 'mainnet' === $network
			? 'http://127.0.0.1:3006'
			: 'http://127.0.0.1:3007';
	}

	/**
	 * Return auth headers to include with bridge requests.
	 *
	 * @return array<string, string>
	 */
	public function get_bridge_headers(): array {
		$mode = $this->get_option( 'connection_mode', 'self_hosted' );
		if ( 'grinpay_server' !== $mode ) {
			return [];
		}
		$api_key = (string) $this->get_option( 'api_key', '' );
		return $api_key ? [ 'X-Api-Key' => $api_key ] : [];
	}

	// ── process_payment ────────────────────────────────────────────────────────

	/**
	 * Called by WooCommerce (Block REST checkout or classic) when buyer places order.
	 *
	 * @param int $order_id
	 * @return array{result: string, redirect: string}
	 */
	public function process_payment( int $order_id ): array {
		$order = wc_get_order( $order_id );

		if ( ! $order ) {
			wc_add_notice( __( 'Order not found. Please try again.', 'grinpay-woocommerce' ), 'error' );
			return [ 'result' => 'failure', 'redirect' => '' ];
		}

		// Self-disable check
		if ( Grinpay_Status::get_instance()->has_critical_failure() ) {
			wc_add_notice( __( 'GrinPay is temporarily unavailable. Please try another payment method.', 'grinpay-woocommerce' ), 'error' );
			return [ 'result' => 'failure', 'redirect' => '' ];
		}

		// Amount in GRIN (product price must already be in GRIN)
		$amount = number_format( (float) $order->get_total(), 9, '.', '' );

		// Call bridge /api/invoice
		$response = $this->bridge_request( 'POST', 'api/invoice', [
			'amount'      => $amount,
			'description' => sprintf(
				/* translators: 1: order ID */
				__( 'Order #%1$s', 'grinpay-woocommerce' ),
				$order_id
			),
		] );

		if ( is_wp_error( $response ) ) {
			$this->log( 'process_payment error: ' . $response->get_error_message() );
			wc_add_notice(
				__( 'GrinPay: Could not create invoice. Please try again or contact support.', 'grinpay-woocommerce' ),
				'error'
			);
			return [ 'result' => 'failure', 'redirect' => '' ];
		}

		$tx_id    = sanitize_text_field( (string) ( $response['tx_id'] ?? '' ) );
		$slatepack = sanitize_textarea_field( (string) ( $response['slatepack'] ?? '' ) );

		if ( empty( $tx_id ) || empty( $slatepack ) ) {
			$this->log( 'process_payment: missing tx_id or slatepack in bridge response.' );
			wc_add_notice( __( 'GrinPay: Invalid invoice response. Please try again.', 'grinpay-woocommerce' ), 'error' );
			return [ 'result' => 'failure', 'redirect' => '' ];
		}

		// Persist to order meta (HPOS-safe)
		$order->update_meta_data( '_grinpay_tx_id',      $tx_id );
		$order->update_meta_data( '_grinpay_amount',     $amount );
		$order->update_meta_data( '_grinpay_slate',      $slatepack );
		$order->update_meta_data( '_grinpay_status',     'pending' );
		$order->update_meta_data( '_grinpay_network',    strtoupper( (string) $this->get_option( 'network', 'testnet' ) ) );
		$order->update_meta_data( '_grinpay_created_at', time() );
		$order->update_status( 'pending-grin', __( 'Awaiting Grin payment via Slatepack.', 'grinpay-woocommerce' ) );
		$order->save();

		$this->log( "Invoice created — order #{$order_id}, tx_id={$tx_id}, amount={$amount}" );

		return [
			'result'   => 'success',
			'redirect' => $this->get_return_url( $order ),
		];
	}

	// ── Thank-you page ─────────────────────────────────────────────────────────

	/**
	 * Hooked to woocommerce_thankyou_{gateway_id}.
	 * Renders the Slatepack invoice + response form inside the WC thank-you template.
	 */
	public function render_thankyou_page( int $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return;
		}

		// Already paid — show confirmation only
		if ( in_array( $order->get_status(), [ 'processing', 'completed' ], true ) ) {
			echo '<div class="grinpay-box grinpay-confirmed">'
				. '<p>' . esc_html__( 'GrinPay: Payment confirmed. Thank you!', 'grinpay-woocommerce' ) . '</p>'
				. '</div>';
			return;
		}

		$slatepack  = (string) $order->get_meta( '_grinpay_slate' );
		$tx_id      = (string) $order->get_meta( '_grinpay_tx_id' );
		$amount     = (string) $order->get_meta( '_grinpay_amount' );
		$network    = (string) $order->get_meta( '_grinpay_network' );
		$created_at = (int) $order->get_meta( '_grinpay_created_at' );
		$expiry_min = (int) $this->get_option( 'expiry_minutes', 30 );
		$expires_at = $created_at + ( $expiry_min * 60 );

		if ( empty( $slatepack ) || empty( $tx_id ) ) {
			echo '<div class="grinpay-box"><p>'
				. esc_html__( 'GrinPay: Invoice data not found. Please contact support with your order number.', 'grinpay-woocommerce' )
				. '</p></div>';
			return;
		}

		$template = GRINPAY_PLUGIN_DIR . 'templates/thankyou.php';
		if ( file_exists( $template ) ) {
			include $template;
		}
	}

	// ── AJAX: submit buyer response slatepack ──────────────────────────────────

	public function ajax_submit_response(): void {
		// Verify nonce
		if ( ! check_ajax_referer( 'grinpay_submit_response', 'nonce', false ) ) {
			wp_send_json_error( [ 'message' => __( 'Security check failed.', 'grinpay-woocommerce' ) ], 403 );
		}

		$order_id       = isset( $_POST['order_id'] ) ? absint( $_POST['order_id'] ) : 0;
		$response_slate = isset( $_POST['response_slate'] ) ? sanitize_textarea_field( wp_unslash( (string) $_POST['response_slate'] ) ) : '';

		if ( ! $order_id || empty( $response_slate ) ) {
			wp_send_json_error( [ 'message' => __( 'Missing order ID or response slatepack.', 'grinpay-woocommerce' ) ], 400 );
		}

		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			wp_send_json_error( [ 'message' => __( 'Order not found.', 'grinpay-woocommerce' ) ], 404 );
		}

		// Verify this order belongs to the current session (guest or logged-in)
		$order_key = isset( $_POST['order_key'] ) ? sanitize_text_field( wp_unslash( (string) $_POST['order_key'] ) ) : '';
		if ( ! $order->key_is_valid( $order_key ) ) {
			wp_send_json_error( [ 'message' => __( 'Invalid order key.', 'grinpay-woocommerce' ) ], 403 );
		}

		$tx_id = (string) $order->get_meta( '_grinpay_tx_id' );

		// Call bridge /api/finalize
		$result = $this->bridge_request( 'POST', 'api/finalize', [
			'response_slate' => $response_slate,
			'tx_id'          => $tx_id,
		] );

		if ( is_wp_error( $result ) ) {
			$this->log( "finalize error order #{$order_id}: " . $result->get_error_message() );
			wp_send_json_error( [
				'message' => __( 'GrinPay: Finalization failed. Ensure you pasted the correct response slatepack.', 'grinpay-woocommerce' ),
			], 500 );
		}

		// Verify amount after finalization
		$expected_amount = (string) $order->get_meta( '_grinpay_amount' );
		$confirmed_tx_id = sanitize_text_field( (string) ( $result['tx_id'] ?? '' ) );

		if ( $confirmed_tx_id && $confirmed_tx_id !== $tx_id ) {
			$this->log( "finalize tx_id mismatch: expected={$tx_id} got={$confirmed_tx_id}" );
			wp_send_json_error( [ 'message' => __( 'Transaction ID mismatch. Contact support.', 'grinpay-woocommerce' ) ], 500 );
		}

		// Mark order paid
		$order->update_meta_data( '_grinpay_status', 'confirmed' );
		$order->payment_complete( $tx_id );
		$order->add_order_note(
			sprintf(
				/* translators: 1: tx_id 2: amount */
				__( 'GrinPay: payment confirmed. TX: %1$s — Amount: %2$s GRIN', 'grinpay-woocommerce' ),
				$tx_id,
				$expected_amount
			)
		);
		$order->save();

		$this->log( "Payment confirmed — order #{$order_id}, tx_id={$tx_id}" );

		wp_send_json_success( [
			'message'  => __( 'Payment confirmed! Your order is now processing.', 'grinpay-woocommerce' ),
			'redirect' => $this->get_return_url( $order ),
		] );
	}

	// ── AJAX: poll tx status ───────────────────────────────────────────────────

	public function ajax_poll_status(): void {
		if ( ! check_ajax_referer( 'grinpay_poll_status', 'nonce', false ) ) {
			wp_send_json_error( [ 'message' => __( 'Security check failed.', 'grinpay-woocommerce' ) ], 403 );
		}

		$order_id  = isset( $_POST['order_id'] ) ? absint( $_POST['order_id'] ) : 0;
		$order_key = isset( $_POST['order_key'] ) ? sanitize_text_field( wp_unslash( (string) $_POST['order_key'] ) ) : '';

		if ( ! $order_id ) {
			wp_send_json_error( [ 'message' => __( 'Missing order ID.', 'grinpay-woocommerce' ) ], 400 );
		}

		$order = wc_get_order( $order_id );
		if ( ! $order || ! $order->key_is_valid( $order_key ) ) {
			wp_send_json_error( [ 'message' => __( 'Order not found.', 'grinpay-woocommerce' ) ], 404 );
		}

		$status = $order->get_status();

		// Already confirmed
		if ( in_array( $status, [ 'processing', 'completed' ], true ) ) {
			wp_send_json_success( [
				'status'   => 'confirmed',
				'redirect' => $this->get_return_url( $order ),
			] );
		}

		// Still pending — poll bridge
		$tx_id  = (string) $order->get_meta( '_grinpay_tx_id' );
		$result = $this->bridge_request( 'GET', 'api/tx_status/' . rawurlencode( $tx_id ) );

		if ( is_wp_error( $result ) ) {
			wp_send_json_success( [ 'status' => 'pending' ] );
		}

		$confirmed = ! empty( $result['confirmed'] ) && true === $result['confirmed'];

		if ( $confirmed ) {
			$amount = (string) $order->get_meta( '_grinpay_amount' );
			$order->update_meta_data( '_grinpay_status', 'confirmed' );
			$order->payment_complete( $tx_id );
			$order->add_order_note(
				sprintf(
					/* translators: 1: tx_id 2: amount */
					__( 'GrinPay: payment confirmed via cron/poll. TX: %1$s — Amount: %2$s GRIN', 'grinpay-woocommerce' ),
					$tx_id,
					$amount
				)
			);
			$order->save();

			wp_send_json_success( [
				'status'   => 'confirmed',
				'redirect' => $this->get_return_url( $order ),
			] );
		}

		// Check expiry
		$created_at = (int) $order->get_meta( '_grinpay_created_at' );
		$expiry_min = (int) $this->get_option( 'expiry_minutes', 30 );
		$expires_at = $created_at + ( $expiry_min * 60 );

		if ( time() > $expires_at ) {
			$order->update_status( 'cancelled', __( 'GrinPay: invoice expired without payment.', 'grinpay-woocommerce' ) );
			$order->save();
			wp_send_json_success( [ 'status' => 'expired' ] );
		}

		wp_send_json_success( [
			'status'     => 'pending',
			'expires_at' => $expires_at,
		] );
	}

	// ── Cron: check pending orders ─────────────────────────────────────────────

	public static function cron_check_pending_orders(): void {
		$gateway = self::get_instance();
		if ( ! $gateway ) {
			return;
		}

		$orders = wc_get_orders( [
			'status'     => 'pending-grin',
			'limit'      => 50,
			'meta_query' => [
				[
					'key'     => '_grinpay_tx_id',
					'compare' => 'EXISTS',
				],
			],
		] );

		foreach ( $orders as $order ) {
			$tx_id      = (string) $order->get_meta( '_grinpay_tx_id' );
			$created_at = (int) $order->get_meta( '_grinpay_created_at' );
			$expiry_min = (int) $gateway->get_option( 'expiry_minutes', 30 );
			$expires_at = $created_at + ( $expiry_min * 60 );

			// Cancel expired orders
			if ( time() > $expires_at ) {
				$order->update_status( 'cancelled', __( 'GrinPay: invoice expired (cron).', 'grinpay-woocommerce' ) );
				$order->save();
				continue;
			}

			// Skip if tx_id missing
			if ( empty( $tx_id ) ) {
				continue;
			}

			// Poll bridge for confirmation
			$result = $gateway->bridge_request( 'GET', 'api/tx_status/' . rawurlencode( $tx_id ) );
			if ( is_wp_error( $result ) || empty( $result['confirmed'] ) ) {
				continue;
			}

			$amount = (string) $order->get_meta( '_grinpay_amount' );
			$order->update_meta_data( '_grinpay_status', 'confirmed' );
			$order->payment_complete( $tx_id );
			$order->add_order_note(
				sprintf(
					/* translators: 1: tx_id 2: amount */
					__( 'GrinPay: payment confirmed via cron. TX: %1$s — Amount: %2$s GRIN', 'grinpay-woocommerce' ),
					$tx_id,
					$amount
				)
			);
			$order->save();
		}
	}

	// ── Bridge HTTP client ─────────────────────────────────────────────────────

	/**
	 * Make a request to the bridge or GrinPay Server.
	 *
	 * @param string               $method  HTTP method: 'GET' or 'POST'
	 * @param string               $endpoint  e.g. 'api/invoice'
	 * @param array<string, mixed> $body  JSON body for POST requests
	 * @return array<string, mixed>|WP_Error  Decoded JSON array or WP_Error
	 */
	public function bridge_request( string $method, string $endpoint, array $body = [] ): array|WP_Error {
		$url     = trailingslashit( $this->get_bridge_url() ) . ltrim( $endpoint, '/' );
		$headers = array_merge(
			[ 'Content-Type' => 'application/json' ],
			$this->get_bridge_headers()
		);

		$args = [
			'method'    => strtoupper( $method ),
			'timeout'   => 90,
			'sslverify' => 'grinpay_server' === $this->get_option( 'connection_mode', 'self_hosted' ),
			'headers'   => $headers,
		];

		if ( 'POST' === $args['method'] && ! empty( $body ) ) {
			$args['body'] = wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );

		if ( is_wp_error( $response ) ) {
			return $response;
		}

		$code = wp_remote_retrieve_response_code( $response );
		$raw  = wp_remote_retrieve_body( $response );

		if ( (int) $code >= 400 ) {
			$err = json_decode( $raw, true );
			$msg = is_array( $err ) && isset( $err['error'] ) ? (string) $err['error'] : "HTTP {$code}";
			return new WP_Error( 'grinpay_bridge_error', $msg, [ 'status' => $code ] );
		}

		$decoded = json_decode( $raw, true );
		if ( ! is_array( $decoded ) ) {
			return new WP_Error( 'grinpay_parse_error', 'Bridge returned non-JSON response.' );
		}

		return $decoded;
	}

	// ── Helpers ────────────────────────────────────────────────────────────────

	/**
	 * Load bridge-config.php defaults on first use (before admin saves settings).
	 */
	private function maybe_load_bridge_config(): void {
		// Only apply if connection_mode is not yet set in DB
		if ( '' !== $this->get_option( 'connection_mode', '' ) ) {
			return;
		}

		$config_file = GRINPAY_PLUGIN_DIR . 'bridge-config.php';
		if ( ! file_exists( $config_file ) ) {
			return;
		}

		require_once $config_file;

		if ( defined( 'GRINPAY_NETWORK' ) ) {
			$network = strtolower( GRINPAY_NETWORK ) === 'mainnet' ? 'mainnet' : 'testnet';
			$this->update_option( 'network', $network );
		}
		if ( defined( 'GRINPAY_EXPIRY_MIN' ) ) {
			$this->update_option( 'expiry_minutes', (string) GRINPAY_EXPIRY_MIN );
		}
	}

	/**
	 * Debug logger — writes to WooCommerce log if debug mode is on.
	 */
	private function log( string $message ): void {
		if ( 'yes' !== $this->get_option( 'debug', 'no' ) ) {
			return;
		}
		$logger = wc_get_logger();
		$logger->debug( $message, [ 'source' => 'grinpay' ] );
	}

	/**
	 * Get the single gateway instance from WooCommerce payment gateways.
	 */
	private static function get_instance(): ?static {
		if ( ! function_exists( 'WC' ) || ! WC()->payment_gateways() ) {
			return null;
		}
		$gateways = WC()->payment_gateways()->payment_gateways();
		return isset( $gateways['grinpay'] ) && $gateways['grinpay'] instanceof static
			? $gateways['grinpay']
			: null;
	}
}
