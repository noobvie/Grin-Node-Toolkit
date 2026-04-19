<?php
/**
 * Plugin Name:       GrinPay for WooCommerce
 * Plugin URI:        https://github.com/noobvie/Grin-Node-Toolkit
 * Description:       Accept Grin (GRIN) payments in WooCommerce via a local node or GrinPay Server.
 * Version:           1.0.0
 * Requires at least: 6.9
 * Requires PHP:      8.4
 * Author:            Grin Node Toolkit
 * License:           GPL v2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       grinpay-woocommerce
 * WC requires at least: 10.6.1
 * WC tested up to:       10.6.1
 */

defined( 'ABSPATH' ) || exit;

// ── Constants ─────────────────────────────────────────────────────────────────

define( 'GRINPAY_VERSION',     '1.0.0' );
define( 'GRINPAY_MIN_PHP',     '8.4.1' );
define( 'GRINPAY_MIN_WP',      '6.9' );
define( 'GRINPAY_MIN_WC',      '10.6.1' );
define( 'GRINPAY_MIN_NODE',    '5.4.0' );
define( 'GRINPAY_MIN_WALLET',  '5.4.0' );
define( 'GRINPAY_MIN_PYTHON',  '3.10.0' );
define( 'GRINPAY_PLUGIN_FILE', __FILE__ );
define( 'GRINPAY_PLUGIN_DIR',  plugin_dir_path( __FILE__ ) );
define( 'GRINPAY_PLUGIN_URL',  plugin_dir_url( __FILE__ ) );

// ── HPOS + Block checkout compatibility declarations ───────────────────────────

add_action( 'before_woocommerce_init', function (): void {
	if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
			'custom_order_tables',
			__FILE__,
			true
		);
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
			'cart_checkout_blocks',
			__FILE__,
			true
		);
	}
} );

// ── Activation hook ────────────────────────────────────────────────────────────

register_activation_hook( __FILE__, 'grinpay_activate' );

function grinpay_activate(): void {
	if ( version_compare( PHP_VERSION, GRINPAY_MIN_PHP, '<' ) ) {
		deactivate_plugins( plugin_basename( __FILE__ ) );
		wp_die(
			sprintf(
				/* translators: 1: required PHP version 2: current PHP version */
				esc_html__( 'GrinPay requires PHP %1$s or higher. You are running PHP %2$s.', 'grinpay-woocommerce' ),
				GRINPAY_MIN_PHP,
				PHP_VERSION
			)
		);
	}

	if ( version_compare( get_bloginfo( 'version' ), GRINPAY_MIN_WP, '<' ) ) {
		deactivate_plugins( plugin_basename( __FILE__ ) );
		wp_die(
			sprintf(
				/* translators: 1: required WordPress version */
				esc_html__( 'GrinPay requires WordPress %1$s or higher.', 'grinpay-woocommerce' ),
				GRINPAY_MIN_WP
			)
		);
	}

	if ( ! class_exists( 'WooCommerce' ) ) {
		deactivate_plugins( plugin_basename( __FILE__ ) );
		wp_die(
			esc_html__( 'GrinPay requires WooCommerce to be installed and active.', 'grinpay-woocommerce' )
		);
	}

	if ( defined( 'WC_VERSION' ) && version_compare( WC_VERSION, GRINPAY_MIN_WC, '<' ) ) {
		deactivate_plugins( plugin_basename( __FILE__ ) );
		wp_die(
			sprintf(
				/* translators: 1: required WooCommerce version */
				esc_html__( 'GrinPay requires WooCommerce %1$s or higher.', 'grinpay-woocommerce' ),
				GRINPAY_MIN_WC
			)
		);
	}
}

// ── Deactivation hook ─────────────────────────────────────────────────────────

register_deactivation_hook( __FILE__, 'grinpay_deactivate' );

function grinpay_deactivate(): void {
	$timestamp = wp_next_scheduled( 'grinpay_check_pending_orders' );
	if ( $timestamp ) {
		wp_unschedule_event( $timestamp, 'grinpay_check_pending_orders' );
	}
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

add_action( 'plugins_loaded', 'grinpay_init', 20 );

function grinpay_init(): void {
	if ( ! class_exists( 'WooCommerce' ) ) {
		add_action( 'admin_notices', function (): void {
			echo '<div class="error"><p>'
				. esc_html__( 'GrinPay for WooCommerce requires WooCommerce to be installed and active.', 'grinpay-woocommerce' )
				. '</p></div>';
		} );
		return;
	}

	// Load class files
	require_once GRINPAY_PLUGIN_DIR . 'class-grinpay-status.php';
	require_once GRINPAY_PLUGIN_DIR . 'class-grinpay-gateway.php';
	require_once GRINPAY_PLUGIN_DIR . 'class-grinpay-admin.php';
	require_once GRINPAY_PLUGIN_DIR . 'block-support.php';

	// Register WooCommerce gateway
	add_filter( 'woocommerce_payment_gateways', 'grinpay_register_gateway' );

	// Register custom order status (dual-hook: HPOS + CPT)
	grinpay_register_order_status();

	// Custom cron interval
	add_filter( 'cron_schedules', 'grinpay_add_cron_intervals' );

	// Schedule pending order check cron
	add_action( 'grinpay_check_pending_orders', [ 'Grinpay_Gateway', 'cron_check_pending_orders' ] );
	if ( ! wp_next_scheduled( 'grinpay_check_pending_orders' ) ) {
		wp_schedule_event( time(), 'grinpay_five_minutes', 'grinpay_check_pending_orders' );
	}

	// Admin notices for critical failures
	if ( is_admin() ) {
		add_action( 'admin_notices', 'grinpay_admin_notices' );
	}
}

// ── Gateway registration ───────────────────────────────────────────────────────

function grinpay_register_gateway( array $gateways ): array {
	$gateways[] = 'Grinpay_Gateway';
	return $gateways;
}

// ── Custom order status ────────────────────────────────────────────────────────

function grinpay_register_order_status(): void {
	$args = [
		'label'                     => _x( 'Pending Grin Payment', 'Order status', 'grinpay-woocommerce' ),
		'public'                    => true,
		'exclude_from_search'       => false,
		'show_in_admin_all_list'    => true,
		'show_in_admin_status_list' => true,
		'label_count'               => _n_noop(
			'Pending Grin Payment <span class="count">(%s)</span>',
			'Pending Grin Payments <span class="count">(%s)</span>',
			'grinpay-woocommerce'
		),
	];

	// CPT-based (legacy) storage
	register_post_status( 'wc-pending-grin', $args );

	// HPOS storage
	add_filter(
		'woocommerce_register_shop_order_post_statuses',
		function ( array $statuses ) use ( $args ): array {
			$statuses['wc-pending-grin'] = $args;
			return $statuses;
		}
	);

	// Add to WooCommerce order statuses list (both storage modes)
	add_filter(
		'wc_order_statuses',
		function ( array $statuses ): array {
			$statuses['wc-pending-grin'] = _x( 'Pending Grin Payment', 'Order status', 'grinpay-woocommerce' );
			return $statuses;
		}
	);
}

// ── Cron intervals ────────────────────────────────────────────────────────────

function grinpay_add_cron_intervals( array $schedules ): array {
	$schedules['grinpay_five_minutes'] = [
		'interval' => 300,
		'display'  => esc_html__( 'Every 5 Minutes (GrinPay)', 'grinpay-woocommerce' ),
	];
	return $schedules;
}

// ── Admin notices ─────────────────────────────────────────────────────────────

function grinpay_admin_notices(): void {
	// Only show on WooCommerce or GrinPay admin pages to avoid noise
	$screen = get_current_screen();
	if ( ! $screen ) {
		return;
	}

	$wc_pages = [ 'woocommerce_page_wc-settings', 'plugins', 'dashboard' ];
	if ( ! in_array( $screen->id, $wc_pages, true ) ) {
		return;
	}

	$results = Grinpay_Status::get_instance()->check_all();
	$settings_url = admin_url( 'admin.php?page=wc-settings&tab=checkout&section=grinpay' );

	foreach ( $results as $check ) {
		if ( 'critical' !== $check['severity'] ) {
			continue;
		}
		printf(
			'<div class="notice notice-error is-dismissible"><p><strong>GrinPay:</strong> %s &mdash; <a href="%s">%s</a></p></div>',
			esc_html( $check['message'] ),
			esc_url( $settings_url ),
			esc_html__( 'View details →', 'grinpay-woocommerce' )
		);
	}
}
