/**
 * GrinPay — WooCommerce Block Checkout payment method component.
 *
 * Vanilla JS (no JSX / build step).  WooCommerce Blocks exposes the React
 * element factory via `window.wp.element` and helper utilities via the
 * `wc.blocksRegistry` / `wc.settings` globals, so we can register a full
 * block payment method without a build tool.
 *
 * The component renders a brief description in the checkout payment step.
 * The actual Slatepack exchange happens on the thank-you page (templates/thankyou.php).
 *
 * @package GrinPay_WooCommerce
 */

( function () {
	'use strict';

	// ── Guard: bail if WC Blocks registry is unavailable ──────────────────────
	if (
		! window.wc ||
		! window.wc.wcBlocksRegistry ||
		! window.wp ||
		! window.wp.element
	) {
		return;
	}

	var registerPaymentMethod = window.wc.wcBlocksRegistry.registerPaymentMethod;
	var getSetting            = window.wc.wcSettings ? window.wc.wcSettings.getSetting : null;
	var createElement         = window.wp.element.createElement;
	var Fragment              = window.wp.element.Fragment;
	var RawHTML               = window.wp.element.RawHTML || null;

	// ── Retrieve data passed from get_payment_method_data() ───────────────────
	var settings = getSetting ? getSetting( 'grinpay_data', {} ) : {};
	var title       = settings.title       || 'Pay with Grin (GRIN)';
	var description = settings.description || '';
	var logoUrl     = settings.logo_url    || '';

	// ── Helper: render raw HTML safely (description may contain links) ─────────
	function renderDescription( text ) {
		if ( ! text ) return null;
		// Use RawHTML if available (wp-element ≥ 5.x), otherwise plain text.
		if ( RawHTML ) {
			return createElement( RawHTML, null, text );
		}
		return createElement( 'p', { className: 'grinpay-block-desc' }, text );
	}

	// ── Label component ────────────────────────────────────────────────────────
	function GrinPayLabel( props ) {
		var PaymentMethodLabel = props.components && props.components.PaymentMethodLabel;
		var labelContent = createElement(
			Fragment,
			null,
			logoUrl
				? createElement( 'img', {
					src:       logoUrl,
					alt:       'Grin',
					className: 'grinpay-block-logo',
					style:     { height: '20px', marginRight: '8px', verticalAlign: 'middle' },
				  } )
				: null,
			PaymentMethodLabel
				? createElement( PaymentMethodLabel, { text: title } )
				: createElement( 'span', null, title )
		);
		return labelContent;
	}

	// ── Content component (shown in the payment accordion body) ───────────────
	function GrinPayContent() {
		return createElement(
			'div',
			{ className: 'grinpay-block-content' },
			renderDescription( description )
		);
	}

	// ── Edit component (shown in the block editor preview) ────────────────────
	function GrinPayEdit() {
		return createElement(
			'div',
			{ className: 'grinpay-block-edit-preview' },
			createElement( 'strong', null, title ),
			description ? createElement( 'p', null, description ) : null
		);
	}

	// ── Register ───────────────────────────────────────────────────────────────
	registerPaymentMethod( {
		name:    'grinpay',
		label:   createElement( GrinPayLabel, null ),
		content: createElement( GrinPayContent, null ),
		edit:    createElement( GrinPayEdit, null ),
		/**
		 * canMakePayment — always true client-side; real gating is done
		 * server-side via Grinpay_Block_Support::is_active().
		 */
		canMakePayment: function () {
			return true;
		},
		ariaLabel:      title,
		supports:       {
			features: settings.supports || [ 'products' ],
		},
	} );

} )();
