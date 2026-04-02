/**
 * GrinPay Admin — settings page JavaScript.
 *
 * Handles:
 *  - Connection Mode radio buttons (show/hide conditional field rows)
 *  - Network toggle → auto-config table update (self-hosted mode)
 *  - Test Connection button → AJAX call → display result
 *  - API key "Show / Hide" toggle
 *  - Copy-to-clipboard for read-only fields
 *
 * All data injected via wp_localize_script( 'grinpay-admin', 'grinpayAdmin', {...} )
 * (see Grinpay_Admin::enqueue_assets).
 *
 * @package GrinPay_WooCommerce
 */

( function ( GP ) {
	'use strict';

	if ( ! GP ) return;

	// ── Config from PHP ──────────────────────────────────────────────────────
	var ajaxUrl        = GP.ajaxUrl        || '';
	var nonce          = GP.nonce          || '';
	var selfHostedConf = GP.selfHosted     || {};   // { mainnet: {...}, testnet: {...} }
	var i18n           = GP.i18n           || {};

	// ── DOM refs (cached once on DOMContentLoaded) ───────────────────────────
	var modeRadios          = null;  // NodeList of input[name="connection_mode"]
	var networkSelect       = null;  // <select id="grinpay_network">
	var selfHostedRows      = null;  // NodeList .grinpay-self-hosted
	var serverModeRows      = null;  // NodeList .grinpay-server-mode
	var autoConfigTable     = null;  // <table id="grinpay-auto-config">
	var testBtn             = null;  // <button id="grinpay-test-btn">
	var testResult          = null;  // <div id="grinpay-test-result">
	var apiKeyInput         = null;  // <input id="grinpay_api_key">
	var apiKeyToggle        = null;  // <button id="grinpay-apikey-toggle">

	// ── Auto-config field mapping ─────────────────────────────────────────────
	// Maps data keys from selfHostedConf to the exact element IDs used in the PHP template.
	var autoConfigFields = {
		bridge_url:  'grinpay_bridge_url',
		bridge_port: 'grinpay_bridge_port',
		net_flag:    'grinpay_net_flag',
		wallet_path: 'grinpay_wallet_path',
	};

	// ── Initialise ────────────────────────────────────────────────────────────
	document.addEventListener( 'DOMContentLoaded', function () {
		modeRadios      = document.querySelectorAll( 'input[name="woocommerce_grinpay_connection_mode"]' );
		// Network uses radio buttons — no single element; use querySelectorAll.
		networkSelect   = document.querySelectorAll( 'input[name="woocommerce_grinpay_network"]' );
		selfHostedRows  = document.querySelectorAll( '.grinpay-self-hosted' );
		serverModeRows  = document.querySelectorAll( '.grinpay-server-mode' );
		autoConfigTable = document.getElementById( 'grinpay_auto_config' );
		testBtn         = document.getElementById( 'grinpay_test_connection' );
		testResult      = document.getElementById( 'grinpay_connection_result' );
		apiKeyInput     = document.getElementById( 'grinpay_api_key' );
		apiKeyToggle    = document.getElementById( 'grinpay_toggle_key' );

		bindModeRadios();
		bindNetworkSelect();
		bindTestButton();
		bindApiKeyToggle();

		// Set initial state based on current saved value.
		var checkedMode = document.querySelector( 'input[name="woocommerce_grinpay_connection_mode"]:checked' );
		if ( checkedMode ) {
			applyConnectionMode( checkedMode.value );
		}
		var checkedNetwork = document.querySelector( 'input[name="woocommerce_grinpay_network"]:checked' );
		if ( checkedNetwork ) {
			updateAutoConfig( checkedNetwork.value );
		}
	} );

	// ── Connection Mode ───────────────────────────────────────────────────────

	function bindModeRadios() {
		if ( ! modeRadios || ! modeRadios.length ) return;
		modeRadios.forEach( function ( radio ) {
			radio.addEventListener( 'change', function () {
				applyConnectionMode( this.value );
			} );
		} );
	}

	/**
	 * Show/hide rows depending on the selected connection mode.
	 *
	 * @param {string} mode  'self_hosted' | 'grinpay_server'
	 */
	function applyConnectionMode( mode ) {
		var isSelfHosted = ( 'self_hosted' === mode );

		toggleRows( selfHostedRows, isSelfHosted );
		toggleRows( serverModeRows, ! isSelfHosted );

		// Auto-config only meaningful in self-hosted mode.
		if ( autoConfigTable ) {
			autoConfigTable.style.display = isSelfHosted ? '' : 'none';
		}

		// Clear test result on mode switch to avoid stale state.
		clearTestResult();
	}

	function toggleRows( rows, visible ) {
		if ( ! rows ) return;
		rows.forEach( function ( row ) {
			row.style.display = visible ? '' : 'none';
		} );
	}

	// ── Network auto-config ───────────────────────────────────────────────────

	function bindNetworkSelect() {
		if ( ! networkSelect || ! networkSelect.length ) return;
		networkSelect.forEach( function ( radio ) {
			radio.addEventListener( 'change', function () {
				updateAutoConfig( this.value );
			} );
		} );
	}

	/**
	 * Populate read-only auto-config cells from the PHP-injected selfHostedConf object.
	 *
	 * @param {string} network 'mainnet' | 'testnet'
	 */
	function updateAutoConfig( network ) {
		if ( ! selfHostedConf || ! selfHostedConf[ network ] ) return;
		var conf = selfHostedConf[ network ];

		Object.keys( autoConfigFields ).forEach( function ( key ) {
			var cell = document.getElementById( autoConfigFields[ key ] );
			if ( cell && undefined !== conf[ key ] ) {
				cell.textContent = conf[ key ];
			}
		} );
	}

	// ── Test Connection ───────────────────────────────────────────────────────

	function bindTestButton() {
		if ( ! testBtn ) return;
		testBtn.addEventListener( 'click', handleTestConnection );
	}

	function handleTestConnection() {
		var checkedMode    = document.querySelector( 'input[name="woocommerce_grinpay_connection_mode"]:checked' );
		var mode           = checkedMode ? checkedMode.value : 'self_hosted';
		var checkedNetwork = document.querySelector( 'input[name="woocommerce_grinpay_network"]:checked' );
		var network        = checkedNetwork ? checkedNetwork.value : 'mainnet';
		var serverUrl   = getFieldValue( 'woocommerce_grinpay_server_url' );
		var apiKey      = getFieldValue( 'woocommerce_grinpay_api_key' );

		testBtn.disabled    = true;
		testBtn.textContent = i18n.testing || 'Testing\u2026';
		clearTestResult();

		var body = new URLSearchParams();
		body.append( 'action',     'grinpay_test_connection' );
		body.append( 'nonce',      nonce );
		body.append( 'mode',       mode );
		body.append( 'network',    network );
		body.append( 'server_url', serverUrl );
		body.append( 'api_key',    apiKey );

		fetch( ajaxUrl, {
			method:      'POST',
			credentials: 'same-origin',
			headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:        body.toString(),
		} )
		.then( function ( res ) { return res.json(); } )
		.then( function ( data ) {
			if ( data.success ) {
				showTestResult( buildSuccessHtml( data.data ), 'success' );
			} else {
				var msg = ( data.data && data.data.message ) ? data.data.message : ( i18n.unknownError || 'Unknown error' );
				showTestResult( escHtml( msg ), 'error' );
			}
		} )
		.catch( function ( err ) {
			showTestResult( escHtml( err.message ), 'error' );
		} )
		.finally( function () {
			testBtn.disabled    = false;
			testBtn.textContent = i18n.testConnection || 'Test Connection';
		} );
	}

	/**
	 * Build a human-readable success detail block from the AJAX response data.
	 *
	 * @param {Object} d  data.data from the AJAX response
	 * @returns {string}  HTML string (safe — all values are escaped)
	 */
	function buildSuccessHtml( d ) {
		if ( ! d ) return escHtml( i18n.connected || 'Connected' );

		var rows = [];

		if ( d.node_version )   rows.push( [ 'Node',    d.node_version ] );
		if ( d.wallet_version ) rows.push( [ 'Wallet',  d.wallet_version ] );
		if ( d.python_version ) rows.push( [ 'Python',  d.python_version ] );
		if ( d.network )        rows.push( [ 'Network', d.network ] );
		if ( d.address )        rows.push( [ 'Address', d.address ] );

		if ( ! rows.length ) {
			return '<span class="grinpay-test-ok">' + escHtml( i18n.connected || 'Connected \u2714' ) + '</span>';
		}

		var html = '<span class="grinpay-test-ok">' + escHtml( i18n.connected || 'Connected \u2714' ) + '</span><table class="grinpay-test-details">';
		rows.forEach( function ( row ) {
			html += '<tr><th>' + escHtml( row[0] ) + '</th><td>' + escHtml( row[1] ) + '</td></tr>';
		} );
		html += '</table>';
		return html;
	}

	function showTestResult( html, type ) {
		if ( ! testResult ) return;
		testResult.innerHTML  = html;
		testResult.className  = 'grinpay-test-result grinpay-test-result--' + type;
		testResult.style.display = '';
	}

	function clearTestResult() {
		if ( ! testResult ) return;
		testResult.innerHTML     = '';
		testResult.style.display = 'none';
	}

	// ── API Key toggle ────────────────────────────────────────────────────────

	function bindApiKeyToggle() {
		if ( ! apiKeyToggle || ! apiKeyInput ) return;
		apiKeyToggle.addEventListener( 'click', function () {
			var isPassword = ( 'password' === apiKeyInput.type );
			apiKeyInput.type    = isPassword ? 'text' : 'password';
			apiKeyToggle.textContent = isPassword
				? ( i18n.hide || 'Hide' )
				: ( i18n.show || 'Show' );
		} );
	}

	// ── Utilities ─────────────────────────────────────────────────────────────

	function getFieldValue( id ) {
		var el = document.getElementById( id );
		return el ? el.value : '';
	}

	function escHtml( str ) {
		var d = document.createElement( 'div' );
		d.appendChild( document.createTextNode( String( str ) ) );
		return d.innerHTML;
	}

} )( window.grinpayAdmin || null );
