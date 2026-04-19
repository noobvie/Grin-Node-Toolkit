<?php
/**
 * Grinpay_Admin — admin settings tabs and system status UI.
 *
 * Renders three tabs for the GrinPay gateway settings page:
 *   [General] [System Status] [Orders]
 *
 * Hooked into WooCommerce payment gateway settings via
 * woocommerce_settings_api_sanitized_fields_{gateway_id}.
 */

defined( 'ABSPATH' ) || exit;

class Grinpay_Admin {

	private static ?Grinpay_Admin $instance = null;

	public static function get_instance(): static {
		if ( null === static::$instance ) {
			static::$instance = new static();
		}
		return static::$instance;
	}

	private function __construct() {
		// Replace default WooCommerce gateway settings form with tabbed UI
		add_action( 'woocommerce_settings_checkout_grinpay', [ $this, 'render_settings_page' ] );

		// Enqueue admin assets only on GrinPay settings page
		add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_assets' ] );

		// AJAX: live bridge/server connection test
		add_action( 'wp_ajax_grinpay_test_connection', [ $this, 'ajax_test_connection' ] );
	}

	// ── Asset enqueueing ───────────────────────────────────────────────────────

	public function enqueue_assets( string $hook ): void {
		if ( ! $this->is_grinpay_settings_page() ) {
			return;
		}

		wp_enqueue_style(
			'grinpay-admin',
			GRINPAY_PLUGIN_URL . 'assets/css/grinpay-admin.css',
			[],
			GRINPAY_VERSION
		);

		wp_enqueue_script(
			'grinpay-admin',
			GRINPAY_PLUGIN_URL . 'assets/js/grinpay-admin.js',
			[ 'jquery' ],
			GRINPAY_VERSION,
			true
		);

		wp_localize_script( 'grinpay-admin', 'grinpayAdmin', [
			'ajaxUrl' => admin_url( 'admin-ajax.php' ),
			'nonce'   => wp_create_nonce( 'grinpay_admin' ),
			'i18n'    => [
				'testing'        => __( 'Testing…', 'grinpay-woocommerce' ),
				'testConnection' => __( 'Test Connection', 'grinpay-woocommerce' ),
				'connected'      => __( 'Connected ✔', 'grinpay-woocommerce' ),
				'failed'         => __( 'Failed', 'grinpay-woocommerce' ),
				'unknownError'   => __( 'Unknown error', 'grinpay-woocommerce' ),
				'copied'         => __( 'Copied!', 'grinpay-woocommerce' ),
				'copy'           => __( 'Copy', 'grinpay-woocommerce' ),
				'show'           => __( 'Show', 'grinpay-woocommerce' ),
				'hide'           => __( 'Hide', 'grinpay-woocommerce' ),
			],
		] );
	}

	// ── Main settings page renderer ────────────────────────────────────────────

	public function render_settings_page(): void {
		$gateway    = $this->get_gateway();
		$active_tab = isset( $_GET['grinpay_tab'] ) ? sanitize_key( $_GET['grinpay_tab'] ) : 'general';
		$tabs       = [
			'general' => __( 'General', 'grinpay-woocommerce' ),
			'status'  => __( 'System Status', 'grinpay-woocommerce' ),
			'orders'  => __( 'Orders', 'grinpay-woocommerce' ),
		];

		$base_url = admin_url( 'admin.php?page=wc-settings&tab=checkout&section=grinpay' );
		?>
		<div class="grinpay-admin-wrap">

			<nav class="grinpay-tabs">
				<?php foreach ( $tabs as $slug => $label ) : ?>
					<a href="<?php echo esc_url( $base_url . '&grinpay_tab=' . $slug ); ?>"
					   class="grinpay-tab<?php echo $active_tab === $slug ? ' grinpay-tab--active' : ''; ?>">
						<?php echo esc_html( $label ); ?>
					</a>
				<?php endforeach; ?>
			</nav>

			<div class="grinpay-tab-content">
				<?php
				match ( $active_tab ) {
					'status' => $this->render_status_tab(),
					'orders' => $this->render_orders_tab(),
					default  => $this->render_general_tab( $gateway ),
				};
				?>
			</div>

		</div>
		<?php
	}

	// ── Tab: General ───────────────────────────────────────────────────────────

	private function render_general_tab( ?Grinpay_Gateway $gateway ): void {
		if ( ! $gateway ) {
			echo '<p>' . esc_html__( 'Gateway not available.', 'grinpay-woocommerce' ) . '</p>';
			return;
		}

		$mode       = $gateway->get_option( 'connection_mode', 'self_hosted' );
		$network    = $gateway->get_option( 'network', 'testnet' );
		$server_url = $gateway->get_option( 'server_url', '' );
		$expiry     = $gateway->get_option( 'expiry_minutes', '30' );
		$confirms   = $gateway->get_option( 'confirmations', '1' );
		$debug      = $gateway->get_option( 'debug', 'no' );

		// Bridge auto-config values (read-only, shown for info)
		$bridge_url  = 'mainnet' === $network ? 'http://127.0.0.1:3006' : 'http://127.0.0.1:3007';
		$bridge_port = 'mainnet' === $network ? '3006' : '3007';
		$net_flag    = 'mainnet' === $network ? '(none)' : '--testnet';
		$wallet_path = 'mainnet' === $network ? '~/.grin/main/' : '~/.grin/test/';

		$action_url = admin_url( 'admin.php?page=wc-settings&tab=checkout&section=grinpay&grinpay_tab=general' );
		?>
		<form method="post" action="<?php echo esc_url( $action_url ); ?>">
			<?php wp_nonce_field( 'woocommerce-settings' ); ?>
			<input type="hidden" name="save" value="1">

			<table class="form-table grinpay-settings-table">

				<?php // ── Enable ── ?>
				<tr>
					<th><?php esc_html_e( 'Enable / Disable', 'grinpay-woocommerce' ); ?></th>
					<td>
						<label>
							<input type="checkbox" name="woocommerce_grinpay_enabled"
								   value="yes" <?php checked( $gateway->get_option( 'enabled', 'no' ), 'yes' ); ?>>
							<?php esc_html_e( 'Enable GrinPay for WooCommerce', 'grinpay-woocommerce' ); ?>
						</label>
					</td>
				</tr>

				<?php // ── Title ── ?>
				<tr>
					<th><label for="grinpay_title"><?php esc_html_e( 'Title', 'grinpay-woocommerce' ); ?></label></th>
					<td>
						<input type="text" id="grinpay_title" name="woocommerce_grinpay_title"
							   value="<?php echo esc_attr( $gateway->get_option( 'title', 'Grin (GRIN)' ) ); ?>"
							   class="regular-text">
						<p class="description"><?php esc_html_e( 'Shown to buyer at checkout.', 'grinpay-woocommerce' ); ?></p>
					</td>
				</tr>

				<?php // ── Description ── ?>
				<tr>
					<th><label for="grinpay_description"><?php esc_html_e( 'Description', 'grinpay-woocommerce' ); ?></label></th>
					<td>
						<textarea id="grinpay_description" name="woocommerce_grinpay_description"
								  rows="3" class="regular-text"><?php echo esc_textarea( $gateway->get_option( 'description', '' ) ); ?></textarea>
						<p class="description"><?php esc_html_e( 'Shown to buyer at checkout.', 'grinpay-woocommerce' ); ?></p>
					</td>
				</tr>

				<?php // ── Separator ── ?>
				<tr><td colspan="2"><hr><h3><?php esc_html_e( 'Connection Mode', 'grinpay-woocommerce' ); ?></h3></td></tr>

				<?php // ── Connection Mode ── ?>
				<tr>
					<th><?php esc_html_e( 'Mode', 'grinpay-woocommerce' ); ?></th>
					<td>
						<fieldset>
							<label>
								<input type="radio" name="woocommerce_grinpay_connection_mode"
									   value="self_hosted" id="grinpay_mode_self"
									   <?php checked( $mode, 'self_hosted' ); ?>>
								<strong><?php esc_html_e( 'Self-hosted', 'grinpay-woocommerce' ); ?></strong>
								&mdash; <?php esc_html_e( 'Local grin node + GrinPay bridge on this server.', 'grinpay-woocommerce' ); ?>
							</label>
							<br><br>
							<label>
								<input type="radio" name="woocommerce_grinpay_connection_mode"
									   value="grinpay_server" id="grinpay_mode_server"
									   <?php checked( $mode, 'grinpay_server' ); ?>>
								<strong><?php esc_html_e( 'GrinPay Server', 'grinpay-woocommerce' ); ?></strong>
								&mdash; <?php esc_html_e( 'Connect to a remote GrinPay Server instance. No local node needed.', 'grinpay-woocommerce' ); ?>
							</label>
						</fieldset>
					</td>
				</tr>

				<?php // ── Self-hosted: Network ── ?>
				<tr class="grinpay-mode-row grinpay-self-hosted" id="grinpay_row_network">
					<th><?php esc_html_e( 'Network', 'grinpay-woocommerce' ); ?></th>
					<td>
						<?php if ( 'mainnet' === $network ) : ?>
							<div class="grinpay-notice grinpay-notice--warning">
								⚠ <?php esc_html_e( 'MAINNET selected — real GRIN will be charged.', 'grinpay-woocommerce' ); ?>
							</div>
						<?php endif; ?>
						<fieldset>
							<label>
								<input type="radio" name="woocommerce_grinpay_network"
									   value="testnet" <?php checked( $network, 'testnet' ); ?> id="grinpay_net_testnet">
								<?php esc_html_e( 'Testnet — tGRIN for testing', 'grinpay-woocommerce' ); ?>
							</label>
							<br>
							<label>
								<input type="radio" name="woocommerce_grinpay_network"
									   value="mainnet" <?php checked( $network, 'mainnet' ); ?> id="grinpay_net_mainnet">
								<?php esc_html_e( 'Mainnet — real GRIN', 'grinpay-woocommerce' ); ?>
							</label>
						</fieldset>
						<br>
						<table class="grinpay-auto-config" id="grinpay_auto_config">
							<caption><?php esc_html_e( 'Auto-configured (read-only, derived from network above)', 'grinpay-woocommerce' ); ?></caption>
							<tr>
								<td><?php esc_html_e( 'Bridge URL', 'grinpay-woocommerce' ); ?></td>
								<td><code id="grinpay_bridge_url"><?php echo esc_html( $bridge_url ); ?></code></td>
							</tr>
							<tr>
								<td><?php esc_html_e( 'Bridge port', 'grinpay-woocommerce' ); ?></td>
								<td><code id="grinpay_bridge_port"><?php echo esc_html( $bridge_port ); ?></code></td>
							</tr>
							<tr>
								<td><?php esc_html_e( 'Network flag', 'grinpay-woocommerce' ); ?></td>
								<td><code id="grinpay_net_flag"><?php echo esc_html( $net_flag ); ?></code></td>
							</tr>
							<tr>
								<td><?php esc_html_e( 'Wallet path', 'grinpay-woocommerce' ); ?></td>
								<td><code id="grinpay_wallet_path"><?php echo esc_html( $wallet_path ); ?></code></td>
							</tr>
						</table>
					</td>
				</tr>

				<?php // ── GrinPay Server: URL + Key ── ?>
				<tr class="grinpay-mode-row grinpay-server-mode" id="grinpay_row_server_url">
					<th><label for="grinpay_server_url"><?php esc_html_e( 'Server URL', 'grinpay-woocommerce' ); ?></label></th>
					<td>
						<input type="url" id="grinpay_server_url" name="woocommerce_grinpay_server_url"
							   value="<?php echo esc_attr( $server_url ); ?>"
							   placeholder="https://pay.yourserver.com"
							   class="regular-text">
						<button type="button" class="button" id="grinpay_test_connection">
							<?php esc_html_e( 'Test Connection', 'grinpay-woocommerce' ); ?>
						</button>
						<span id="grinpay_connection_result"></span>
					</td>
				</tr>

				<tr class="grinpay-mode-row grinpay-server-mode" id="grinpay_row_api_key">
					<th><label for="grinpay_api_key"><?php esc_html_e( 'API Key', 'grinpay-woocommerce' ); ?></label></th>
					<td>
						<input type="password" id="grinpay_api_key" name="woocommerce_grinpay_api_key"
							   value="<?php echo esc_attr( $gateway->get_option( 'api_key', '' ) ); ?>"
							   class="regular-text" autocomplete="new-password">
						<button type="button" class="button" id="grinpay_toggle_key">
							<?php esc_html_e( 'Show', 'grinpay-woocommerce' ); ?>
						</button>
					</td>
				</tr>

				<?php // ── Separator ── ?>
				<tr><td colspan="2"><hr><h3><?php esc_html_e( 'Payment', 'grinpay-woocommerce' ); ?></h3></td></tr>

				<?php // ── Expiry ── ?>
				<tr>
					<th><label for="grinpay_expiry"><?php esc_html_e( 'Invoice Expiry', 'grinpay-woocommerce' ); ?></label></th>
					<td>
						<input type="number" id="grinpay_expiry" name="woocommerce_grinpay_expiry_minutes"
							   value="<?php echo esc_attr( $expiry ); ?>"
							   min="5" max="1440" class="small-text">
						<?php esc_html_e( 'minutes', 'grinpay-woocommerce' ); ?>
						<p class="description"><?php esc_html_e( 'Orders are auto-cancelled if unpaid after this time.', 'grinpay-woocommerce' ); ?></p>
					</td>
				</tr>

				<?php // ── Confirmations ── ?>
				<tr>
					<th><label for="grinpay_confirmations"><?php esc_html_e( 'Confirmations Required', 'grinpay-woocommerce' ); ?></label></th>
					<td>
						<input type="number" id="grinpay_confirmations" name="woocommerce_grinpay_confirmations"
							   value="<?php echo esc_attr( $confirms ); ?>"
							   min="1" max="100" class="small-text">
						<p class="description"><?php esc_html_e( 'Testnet: 1 recommended. Mainnet: 10 recommended.', 'grinpay-woocommerce' ); ?></p>
					</td>
				</tr>

				<?php // ── Debug ── ?>
				<tr><td colspan="2"><hr><h3><?php esc_html_e( 'Debug', 'grinpay-woocommerce' ); ?></h3></td></tr>
				<tr>
					<th><?php esc_html_e( 'Debug Logging', 'grinpay-woocommerce' ); ?></th>
					<td>
						<label>
							<input type="checkbox" name="woocommerce_grinpay_debug"
								   value="yes" <?php checked( $debug, 'yes' ); ?>>
							<?php esc_html_e( 'Enable debug log', 'grinpay-woocommerce' ); ?>
						</label>
						<p class="description">
							<?php
							printf(
								/* translators: 1: link to WC logs */
								esc_html__( 'Logs at: %1$s', 'grinpay-woocommerce' ),
								'<a href="' . esc_url( admin_url( 'admin.php?page=wc-status&tab=logs' ) ) . '">WooCommerce → Status → Logs → grinpay</a>'
							);
							?>
						</p>
					</td>
				</tr>

			</table>

			<p class="submit">
				<button type="submit" class="button button-primary">
					<?php esc_html_e( 'Save changes', 'grinpay-woocommerce' ); ?>
				</button>
			</p>

		</form>
		<?php
	}

	// ── Tab: System Status ─────────────────────────────────────────────────────

	private function render_status_tab(): void {
		$results = Grinpay_Status::get_instance()->check_all();
		$mode    = '';
		$gateway = $this->get_gateway();
		if ( $gateway ) {
			$mode = $gateway->get_option( 'connection_mode', 'self_hosted' );
		}

		$overall_ok = true;
		foreach ( $results as $r ) {
			if ( 'critical' === $r['severity'] && 'fail' === $r['status'] ) {
				$overall_ok = false;
				break;
			}
		}

		$recheck_url = admin_url( 'admin.php?page=wc-settings&tab=checkout&section=grinpay&grinpay_tab=status&recheck=1' );
		$logs_url    = admin_url( 'admin.php?page=wc-status&tab=logs' );
		?>
		<div class="grinpay-status-wrap">

			<div class="grinpay-status-actions">
				<a href="<?php echo esc_url( $recheck_url ); ?>" class="button">
					<?php esc_html_e( 'Re-check', 'grinpay-woocommerce' ); ?>
				</a>
				<a href="<?php echo esc_url( $logs_url ); ?>" class="button" target="_blank">
					<?php esc_html_e( 'View Logs', 'grinpay-woocommerce' ); ?>
				</a>
			</div>

			<table class="grinpay-status-table widefat">
				<thead>
					<tr>
						<th><?php esc_html_e( 'Check', 'grinpay-woocommerce' ); ?></th>
						<th><?php esc_html_e( 'Result', 'grinpay-woocommerce' ); ?></th>
						<th><?php esc_html_e( 'Detail', 'grinpay-woocommerce' ); ?></th>
					</tr>
				</thead>
				<tbody>
					<?php foreach ( $results as $r ) : ?>
						<?php
						$icon  = 'ok' === $r['status'] ? '✓' : ( 'critical' === $r['severity'] ? '✗' : '⚠' );
						$class = 'ok' === $r['status'] ? 'grinpay-ok' : ( 'critical' === $r['severity'] ? 'grinpay-fail' : 'grinpay-warn' );
						?>
						<tr class="<?php echo esc_attr( $class ); ?>">
							<td><?php echo esc_html( $r['label'] ); ?></td>
							<td>
								<span class="grinpay-status-icon"><?php echo esc_html( $icon ); ?></span>
								<?php echo esc_html( $r['message'] ); ?>
							</td>
							<td><small><?php echo esc_html( $r['detail'] ); ?></small></td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>

			<div class="grinpay-overall-status <?php echo $overall_ok ? 'grinpay-ok' : 'grinpay-fail'; ?>">
				<?php if ( $overall_ok ) : ?>
					✓ <?php esc_html_e( 'All systems operational — gateway is accepting payments.', 'grinpay-woocommerce' ); ?>
				<?php else : ?>
					✗ <?php esc_html_e( 'Gateway DISABLED — critical errors above must be resolved.', 'grinpay-woocommerce' ); ?>
				<?php endif; ?>
			</div>

		</div>
		<?php
	}

	// ── Tab: Orders ────────────────────────────────────────────────────────────

	private function render_orders_tab(): void {
		$orders = wc_get_orders( [
			'status' => [ 'pending-grin', 'cancelled' ],
			'limit'  => 50,
			'orderby' => 'date',
			'order'   => 'DESC',
		] );

		$gateway    = $this->get_gateway();
		$expiry_min = $gateway ? (int) $gateway->get_option( 'expiry_minutes', 30 ) : 30;
		?>
		<div class="grinpay-orders-wrap">
			<h3><?php esc_html_e( 'Pending GrinPay Payments', 'grinpay-woocommerce' ); ?></h3>

			<?php if ( empty( $orders ) ) : ?>
				<p><?php esc_html_e( 'No pending or recently expired Grin orders.', 'grinpay-woocommerce' ); ?></p>
			<?php else : ?>
				<table class="grinpay-orders-table widefat">
					<thead>
						<tr>
							<th><?php esc_html_e( 'Order', 'grinpay-woocommerce' ); ?></th>
							<th><?php esc_html_e( 'Amount (GRIN)', 'grinpay-woocommerce' ); ?></th>
							<th><?php esc_html_e( 'Status', 'grinpay-woocommerce' ); ?></th>
							<th><?php esc_html_e( 'Expires', 'grinpay-woocommerce' ); ?></th>
							<th><?php esc_html_e( 'Actions', 'grinpay-woocommerce' ); ?></th>
						</tr>
					</thead>
					<tbody>
						<?php foreach ( $orders as $order ) : ?>
							<?php
							$created_at = (int) $order->get_meta( '_grinpay_created_at' );
							$expires_at = $created_at + ( $expiry_min * 60 );
							$remaining  = $expires_at - time();
							$amount     = (string) $order->get_meta( '_grinpay_amount' );
							$status     = $order->get_status();

							if ( $remaining > 0 && 'pending-grin' === $status ) {
								$expires_label = sprintf(
									/* translators: 1: minutes remaining */
									__( '%1$d min left', 'grinpay-woocommerce' ),
									(int) ceil( $remaining / 60 )
								);
							} elseif ( 'cancelled' === $status ) {
								$expires_label = __( 'expired', 'grinpay-woocommerce' );
							} else {
								$expires_label = '—';
							}
							?>
							<tr>
								<td>
									<a href="<?php echo esc_url( $order->get_edit_order_url() ); ?>">
										#<?php echo esc_html( (string) $order->get_id() ); ?>
									</a>
								</td>
								<td><?php echo esc_html( $amount ?: '—' ); ?></td>
								<td><?php echo esc_html( wc_get_order_status_name( $status ) ); ?></td>
								<td><?php echo esc_html( $expires_label ); ?></td>
								<td>
									<a href="<?php echo esc_url( $order->get_edit_order_url() ); ?>" class="button button-small">
										<?php esc_html_e( 'View', 'grinpay-woocommerce' ); ?>
									</a>
									<?php if ( 'pending-grin' === $status ) : ?>
										<a href="<?php echo esc_url( wp_nonce_url(
											admin_url( 'admin-ajax.php?action=grinpay_cancel_order&order_id=' . $order->get_id() ),
											'grinpay_cancel_' . $order->get_id()
										) ); ?>" class="button button-small">
											<?php esc_html_e( 'Cancel', 'grinpay-woocommerce' ); ?>
										</a>
									<?php endif; ?>
								</td>
							</tr>
						<?php endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>
		<?php
	}

	// ── AJAX: Test Connection ──────────────────────────────────────────────────

	public function ajax_test_connection(): void {
		if ( ! check_ajax_referer( 'grinpay_admin', 'nonce', false ) ) {
			wp_send_json_error( [ 'message' => __( 'Security check failed.', 'grinpay-woocommerce' ) ], 403 );
		}

		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_send_json_error( [ 'message' => __( 'Permission denied.', 'grinpay-woocommerce' ) ], 403 );
		}

		$mode       = isset( $_POST['mode'] ) ? sanitize_key( $_POST['mode'] ) : 'self_hosted';
		$server_url = isset( $_POST['server_url'] ) ? sanitize_url( wp_unslash( (string) $_POST['server_url'] ) ) : '';
		$api_key    = isset( $_POST['api_key'] ) ? sanitize_text_field( wp_unslash( (string) $_POST['api_key'] ) ) : '';
		$network    = isset( $_POST['network'] ) ? sanitize_key( $_POST['network'] ) : 'testnet';

		if ( 'grinpay_server' === $mode ) {
			$url     = rtrim( $server_url, '/' ) . '/api/status';
			$headers = $api_key ? [ 'X-Api-Key' => $api_key ] : [];
		} else {
			$url     = 'mainnet' === $network
				? 'http://127.0.0.1:3006/api/status'
				: 'http://127.0.0.1:3007/api/status';
			$headers = [];
		}

		$start    = microtime( true );
		$response = wp_remote_get( $url, [
			'timeout'   => 5,
			'sslverify' => 'grinpay_server' === $mode,
			'headers'   => $headers,
		] );
		$elapsed = (int) round( ( microtime( true ) - $start ) * 1000 );

		if ( is_wp_error( $response ) ) {
			wp_send_json_error( [
				'message' => sprintf(
					/* translators: 1: error message */
					__( 'Connection failed: %1$s', 'grinpay-woocommerce' ),
					$response->get_error_message()
				),
			] );
		}

		$code = wp_remote_retrieve_response_code( $response );

		if ( 401 === (int) $code ) {
			wp_send_json_error( [ 'message' => __( '401 Unauthorized — check your API key.', 'grinpay-woocommerce' ) ] );
		}

		if ( 200 !== (int) $code ) {
			wp_send_json_error( [
				'message' => sprintf(
					/* translators: 1: HTTP code */
					__( 'Server returned HTTP %1$s.', 'grinpay-woocommerce' ),
					$code
				),
			] );
		}

		$body    = json_decode( wp_remote_retrieve_body( $response ), true );
		$network = isset( $body['network'] ) ? strtoupper( (string) $body['network'] ) : '?';
		$balance = isset( $body['balance'] ) ? number_format( (float) $body['balance'], 9 ) : '?';
		$version = $body['version'] ?? $body['bridge_version'] ?? '?';

		wp_send_json_success( [
			'message' => sprintf(
				/* translators: 1: ms 2: version 3: network 4: balance */
				__( 'Connected in %1$dms — v%2$s — %3$s — balance: %4$s GRIN', 'grinpay-woocommerce' ),
				$elapsed,
				$version,
				$network,
				$balance
			),
		] );
	}

	// ── Helpers ────────────────────────────────────────────────────────────────

	private function get_gateway(): ?Grinpay_Gateway {
		if ( ! function_exists( 'WC' ) || ! WC()->payment_gateways() ) {
			return null;
		}
		$all = WC()->payment_gateways()->payment_gateways();
		return isset( $all['grinpay'] ) && $all['grinpay'] instanceof Grinpay_Gateway
			? $all['grinpay']
			: null;
	}

	private function is_grinpay_settings_page(): bool {
		if ( ! is_admin() ) {
			return false;
		}
		$page    = isset( $_GET['page'] ) ? sanitize_key( $_GET['page'] ) : '';
		$tab     = isset( $_GET['tab'] ) ? sanitize_key( $_GET['tab'] ) : '';
		$section = isset( $_GET['section'] ) ? sanitize_key( $_GET['section'] ) : '';
		return 'wc-settings' === $page && 'checkout' === $tab && 'grinpay' === $section;
	}
}

// Initialise
Grinpay_Admin::get_instance();
