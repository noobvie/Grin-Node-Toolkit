<?php
/**
 * GrinPay thank-you page template.
 *
 * Displays:
 *  1. The merchant's Slatepack invoice for the buyer to copy.
 *  2. A textarea for the buyer to paste their signed Slatepack response.
 *  3. A "Submit Payment" button that sends the response to /api/finalize via AJAX.
 *  4. A status poller that periodically checks /api/tx_status/{tx_id}.
 *
 * Variables injected by Grinpay_Gateway::render_thankyou_page():
 *   $order         WC_Order
 *   $slate         string  — Slatepack invoice string (I1 or I2 slate)
 *   $tx_id         string  — Grin Slate UUID stored as _grinpay_tx_id
 *   $expires_at    int     — Unix timestamp when the invoice expires (0 = no expiry)
 *   $network       string  — 'mainnet' | 'testnet'
 *   $order_key     string  — $order->get_order_key()
 *
 * @package GrinPay_WooCommerce
 */

defined( 'ABSPATH' ) || exit;

// These are provided by the gateway — bail safely if anything is missing.
if ( empty( $slate ) || empty( $tx_id ) || ! isset( $order ) ) {
	return;
}

$order_id    = $order->get_id();
$amount_html = wc_price( $order->get_total(), [ 'currency' => $order->get_currency() ] );
$expires_at  = $expires_at ?? 0;
$network     = $network ?? 'mainnet';
$order_key   = $order_key ?? $order->get_order_key();

// Poll interval (ms) — 15 s between checks.
$poll_interval_ms = 15000;
?>

<div class="grinpay-payment-box" id="grinpay-payment-box">

	<?php if ( 'testnet' === $network ) : ?>
	<div class="grinpay-notice grinpay-notice--testnet">
		<?php esc_html_e( 'Testnet mode active — use testnet Grin only.', 'grinpay-woocommerce' ); ?>
	</div>
	<?php endif; ?>

	<!-- ── Step 1: invoice ──────────────────────────────────────────────── -->
	<div class="grinpay-step" id="grinpay-step-invoice">

		<h3 class="grinpay-step__title">
			<?php esc_html_e( 'Step 1 — Copy the Grin Invoice', 'grinpay-woocommerce' ); ?>
		</h3>

		<p class="grinpay-step__desc">
			<?php
			printf(
				/* translators: %s: order amount */
				esc_html__( 'Copy the Slatepack below and import it into your Grin wallet to authorise the payment of %s.', 'grinpay-woocommerce' ),
				wp_kses_post( $amount_html )
			);
			?>
		</p>

		<div class="grinpay-slate-wrap">
			<textarea
				id="grinpay-invoice-slate"
				class="grinpay-slate-textarea"
				readonly
				aria-label="<?php esc_attr_e( 'Grin Slatepack invoice', 'grinpay-woocommerce' ); ?>"
			><?php echo esc_textarea( $slate ); ?></textarea>
			<button
				type="button"
				class="grinpay-btn grinpay-btn--copy"
				data-clipboard-target="#grinpay-invoice-slate"
				aria-label="<?php esc_attr_e( 'Copy Slatepack invoice', 'grinpay-woocommerce' ); ?>"
			>
				<?php esc_html_e( 'Copy', 'grinpay-woocommerce' ); ?>
			</button>
		</div>

		<?php if ( $expires_at > 0 ) : ?>
		<p class="grinpay-expiry" id="grinpay-expiry" data-expires="<?php echo esc_attr( (string) $expires_at ); ?>">
			<?php esc_html_e( 'Invoice expires in:', 'grinpay-woocommerce' ); ?>
			<strong id="grinpay-countdown">--:--</strong>
		</p>
		<?php endif; ?>

	</div><!-- /.grinpay-step-invoice -->

	<!-- ── Step 2: response ─────────────────────────────────────────────── -->
	<div class="grinpay-step" id="grinpay-step-response">

		<h3 class="grinpay-step__title">
			<?php esc_html_e( 'Step 2 — Paste Your Signed Response', 'grinpay-woocommerce' ); ?>
		</h3>

		<p class="grinpay-step__desc">
			<?php esc_html_e( 'After your wallet signs the invoice it will output a Slatepack response. Paste it here and click Submit.', 'grinpay-woocommerce' ); ?>
		</p>

		<div class="grinpay-slate-wrap">
			<textarea
				id="grinpay-response-slate"
				class="grinpay-slate-textarea"
				placeholder="<?php esc_attr_e( 'Paste signed Slatepack response here\u2026', 'grinpay-woocommerce' ); ?>"
				aria-label="<?php esc_attr_e( 'Grin Slatepack response', 'grinpay-woocommerce' ); ?>"
				rows="6"
			></textarea>
		</div>

		<button
			type="button"
			id="grinpay-submit-btn"
			class="button alt grinpay-btn grinpay-btn--submit"
		>
			<?php esc_html_e( 'Submit Payment', 'grinpay-woocommerce' ); ?>
		</button>

		<div id="grinpay-submit-msg" class="grinpay-message" role="alert" aria-live="polite"></div>

	</div><!-- /.grinpay-step-response -->

	<!-- ── Status banner ────────────────────────────────────────────────── -->
	<div id="grinpay-status-banner" class="grinpay-status-banner grinpay-hidden" role="status" aria-live="polite">
		<span id="grinpay-status-text"></span>
	</div>

</div><!-- /.grinpay-payment-box -->

<?php
// Enqueue front-end styles for this template.
wp_enqueue_style(
	'grinpay-thankyou',
	GRINPAY_PLUGIN_URL . 'assets/css/grinpay-thankyou.css',
	[],
	GRINPAY_VERSION
);

// Pass PHP data to the inline JS block below.
$js_data = [
	'ajaxUrl'        => admin_url( 'admin-ajax.php' ),
	'nonce'          => wp_create_nonce( 'grinpay_submit_response' ),
	'pollNonce'      => wp_create_nonce( 'grinpay_poll_status' ),
	'orderId'        => $order_id,
	'orderKey'       => $order_key,
	'txId'           => $tx_id,
	'expiresAt'      => $expires_at,
	'pollInterval'   => $poll_interval_ms,
	'i18n'           => [
		'submitting'     => __( 'Submitting\u2026', 'grinpay-woocommerce' ),
		'success'        => __( 'Payment received! Your order is being processed.', 'grinpay-woocommerce' ),
		'error'          => __( 'Error: ', 'grinpay-woocommerce' ),
		'expired'        => __( 'Invoice expired. Please contact the store.', 'grinpay-woocommerce' ),
		'emptyResponse'  => __( 'Please paste your signed Slatepack response.', 'grinpay-woocommerce' ),
		'copy'           => __( 'Copy', 'grinpay-woocommerce' ),
		'copied'         => __( 'Copied!', 'grinpay-woocommerce' ),
		'pollPending'    => __( 'Waiting for payment confirmation\u2026', 'grinpay-woocommerce' ),
		'pollConfirmed'  => __( 'Payment confirmed!', 'grinpay-woocommerce' ),
	],
];
?>
<script>
( function () {
	'use strict';

	var GP = <?php echo wp_json_encode( $js_data ); ?>;

	// ── Countdown timer ──────────────────────────────────────────────────────
	var countdownEl = document.getElementById( 'grinpay-countdown' );
	if ( countdownEl && GP.expiresAt > 0 ) {
		var tick = function () {
			var remaining = Math.max( 0, GP.expiresAt - Math.floor( Date.now() / 1000 ) );
			var m = Math.floor( remaining / 60 );
			var s = remaining % 60;
			countdownEl.textContent = m + ':' + ( s < 10 ? '0' : '' ) + s;
			if ( remaining <= 0 ) {
				clearInterval( countdownTimer );
				showBanner( GP.i18n.expired, 'error' );
				disableForm();
			}
		};
		tick();
		var countdownTimer = setInterval( tick, 1000 );
	}

	// ── Copy button ──────────────────────────────────────────────────────────
	var copyBtn = document.querySelector( '.grinpay-btn--copy' );
	if ( copyBtn ) {
		copyBtn.addEventListener( 'click', function () {
			var target = document.getElementById( 'grinpay-invoice-slate' );
			if ( ! target ) return;
			if ( navigator.clipboard && navigator.clipboard.writeText ) {
				navigator.clipboard.writeText( target.value ).then( function () {
					flashCopy( copyBtn );
				} );
			} else {
				target.select();
				document.execCommand( 'copy' );
				flashCopy( copyBtn );
			}
		} );
	}

	function flashCopy( btn ) {
		var orig = btn.textContent;
		btn.textContent = GP.i18n.copied;
		btn.classList.add( 'grinpay-btn--copied' );
		setTimeout( function () {
			btn.textContent = orig;
			btn.classList.remove( 'grinpay-btn--copied' );
		}, 1800 );
	}

	// ── Submit response ──────────────────────────────────────────────────────
	var submitBtn = document.getElementById( 'grinpay-submit-btn' );
	var submitMsg = document.getElementById( 'grinpay-submit-msg' );
	if ( submitBtn ) {
		submitBtn.addEventListener( 'click', function () {
			var responseSlate = ( document.getElementById( 'grinpay-response-slate' ).value || '' ).trim();
			if ( ! responseSlate ) {
				showMsg( GP.i18n.emptyResponse, 'error' );
				return;
			}
			submitBtn.disabled = true;
			submitBtn.textContent = GP.i18n.submitting;
			showMsg( '', '' );

			var body = new URLSearchParams();
			body.append( 'action',        'grinpay_submit_response' );
			body.append( 'nonce',         GP.nonce );
			body.append( 'order_id',      GP.orderId );
			body.append( 'order_key',     GP.orderKey );
			body.append( 'slate_response', responseSlate );

			fetch( GP.ajaxUrl, {
				method:      'POST',
				credentials: 'same-origin',
				headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
				body:        body.toString(),
			} )
			.then( function ( res ) { return res.json(); } )
			.then( function ( data ) {
				if ( data.success ) {
					showMsg( GP.i18n.success, 'success' );
					showBanner( GP.i18n.success, 'success' );
					stopPolling();
					if ( data.data && data.data.redirect ) {
						setTimeout( function () {
							window.location.href = data.data.redirect;
						}, 2000 );
					}
				} else {
					var errMsg = ( data.data && data.data.message ) ? data.data.message : 'Unknown error';
					showMsg( GP.i18n.error + errMsg, 'error' );
					submitBtn.disabled    = false;
					submitBtn.textContent = '<?php echo esc_js( __( 'Submit Payment', 'grinpay-woocommerce' ) ); ?>';
				}
			} )
			.catch( function ( err ) {
				showMsg( GP.i18n.error + err.message, 'error' );
				submitBtn.disabled    = false;
				submitBtn.textContent = '<?php echo esc_js( __( 'Submit Payment', 'grinpay-woocommerce' ) ); ?>';
			} );
		} );
	}

	// ── Status polling ───────────────────────────────────────────────────────
	var pollTimer = null;
	if ( GP.pollInterval > 0 && GP.txId ) {
		pollTimer = setInterval( pollStatus, GP.pollInterval );
	}

	function pollStatus() {
		var body = new URLSearchParams();
		body.append( 'action',    'grinpay_poll_status' );
		body.append( 'nonce',     GP.pollNonce );
		body.append( 'order_id',  GP.orderId );
		body.append( 'order_key', GP.orderKey );
		body.append( 'tx_id',     GP.txId );

		fetch( GP.ajaxUrl, {
			method:      'POST',
			credentials: 'same-origin',
			headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:        body.toString(),
		} )
		.then( function ( res ) { return res.json(); } )
		.then( function ( data ) {
			if ( ! data.success ) return;
			var status = data.data && data.data.status ? data.data.status : '';
			if ( 'confirmed' === status || 'completed' === status ) {
				stopPolling();
				showBanner( GP.i18n.pollConfirmed, 'success' );
				if ( data.data.redirect ) {
					setTimeout( function () { window.location.href = data.data.redirect; }, 1500 );
				}
			} else if ( 'expired' === status || 'cancelled' === status ) {
				stopPolling();
				showBanner( GP.i18n.expired, 'error' );
				disableForm();
			}
		} )
		.catch( function () { /* silent — just skip this poll tick */ } );
	}

	function stopPolling() {
		if ( pollTimer ) {
			clearInterval( pollTimer );
			pollTimer = null;
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────────
	function showMsg( text, type ) {
		if ( ! submitMsg ) return;
		submitMsg.textContent  = text;
		submitMsg.className    = 'grinpay-message' + ( type ? ' grinpay-message--' + type : '' );
	}

	function showBanner( text, type ) {
		var banner = document.getElementById( 'grinpay-status-banner' );
		var span   = document.getElementById( 'grinpay-status-text' );
		if ( ! banner || ! span ) return;
		span.textContent  = text;
		banner.className  = 'grinpay-status-banner grinpay-status-banner--' + type;
	}

	function disableForm() {
		var responseArea = document.getElementById( 'grinpay-response-slate' );
		if ( responseArea ) responseArea.disabled = true;
		if ( submitBtn )    submitBtn.disabled    = true;
	}

} )();
</script>
