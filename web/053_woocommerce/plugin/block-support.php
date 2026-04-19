<?php
/**
 * WooCommerce Blocks payment method registration.
 *
 * Registers GrinPay as a Block-checkout-compatible payment method by
 * implementing AbstractPaymentMethodType and enqueueing the vanilla-JS
 * component that calls wc.blocksRegistry.registerPaymentMethod().
 *
 * @package GrinPay_WooCommerce
 */

defined( 'ABSPATH' ) || exit;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

/**
 * Block-checkout integration for GrinPay.
 *
 * Registered via the `woocommerce_blocks_payment_method_type_registration`
 * action so WooCommerce Blocks picks it up automatically.
 */
final class Grinpay_Block_Support extends AbstractPaymentMethodType {

	/**
	 * Payment method name — must match the gateway's $this->id.
	 *
	 * @var string
	 */
	protected $name = 'grinpay';

	/**
	 * Gateway instance (lazy-loaded in initialize()).
	 *
	 * @var Grinpay_Gateway|null
	 */
	private ?Grinpay_Gateway $gateway = null;

	// ── AbstractPaymentMethodType implementation ───────────────────────────────

	/**
	 * Initialise: resolve the gateway instance from WC's loaded gateways.
	 */
	public function initialize(): void {
		$gateways = WC()->payment_gateways()->payment_gateways();
		if ( isset( $gateways['grinpay'] ) && $gateways['grinpay'] instanceof Grinpay_Gateway ) {
			$this->gateway = $gateways['grinpay'];
		}
	}

	/**
	 * Whether the payment method is active (enabled + no critical failures).
	 */
	public function is_active(): bool {
		if ( null === $this->gateway ) {
			return false;
		}
		return 'yes' === $this->gateway->enabled
			&& ! Grinpay_Status::get_instance()->has_critical_failure();
	}

	/**
	 * Script handles to load on the Block checkout page.
	 *
	 * @return string[]
	 */
	public function get_payment_method_script_handles(): array {
		$handle  = 'grinpay-block-payment';
		$js_path = GRINPAY_PLUGIN_DIR . 'assets/js/grinpay-block-payment.js';
		$js_url  = GRINPAY_PLUGIN_URL . 'assets/js/grinpay-block-payment.js';
		$version = file_exists( $js_path )
			? filemtime( $js_path )
			: GRINPAY_VERSION;

		wp_register_script(
			$handle,
			$js_url,
			[ 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities', 'wp-i18n' ],
			(string) $version,
			true
		);

		if ( function_exists( 'wp_set_script_translations' ) ) {
			wp_set_script_translations( $handle, 'grinpay-woocommerce' );
		}

		return [ $handle ];
	}

	/**
	 * Data passed to the JS component via getSetting('grinpay_data').
	 *
	 * @return array<string, mixed>
	 */
	public function get_payment_method_data(): array {
		$title       = __( 'Pay with Grin (GRIN)', 'grinpay-woocommerce' );
		$description = __( 'Pay privately with Grin — a MimbleWimble cryptocurrency. You will receive a Slatepack address after placing your order.', 'grinpay-woocommerce' );
		$supports    = [ 'products' ];

		if ( null !== $this->gateway ) {
			$title       = $this->gateway->get_option( 'title', $title );
			$description = $this->gateway->get_option( 'description', $description );
			$supports    = array_values( $this->gateway->supports );
		}

		return [
			'title'       => $title,
			'description' => $description,
			'supports'    => $supports,
			'logo_url'    => GRINPAY_PLUGIN_URL . 'assets/images/grin-logo.svg',
		];
	}
}

// ── Registration hook ──────────────────────────────────────────────────────────

add_action(
	'woocommerce_blocks_payment_method_type_registration',
	function ( \Automattic\WooCommerce\Blocks\Payments\PaymentMethodRegistry $registry ): void {
		$registry->register( new Grinpay_Block_Support() );
	}
);
