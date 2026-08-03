<?php
/**
 * Drives the plugin's blocking diagnostics against a real running instance of
 * the Next.js app, using a cURL-backed wp_remote_* stub. Verifies that each
 * misconfiguration produces the correct, actionable verdict.
 */

define( 'ABSPATH', '/tmp/wp/' );

$GLOBALS['endpoint'] = getenv( 'ENDPOINT' );
$GLOBALS['secret']   = getenv( 'SECRET' );

function add_action( $h, $c, $p = 10, $a = 1 ) {}
function apply_filters( $f, $v ) { return $v; }
function home_url( $p = '' ) { return 'https://shop.example.com' . $p; }
function admin_url( $p = '' ) { return 'https://shop.example.com/wp-admin/' . $p; }
function is_admin() { return true; }
function is_user_logged_in() { return true; }
function wp_doing_cron() { return false; }
function wp_doing_ajax() { return false; }
function current_user_can( $c ) { return true; }
function get_option( $n, $d = '' ) { return $d; }
function update_option( $n, $v, $a = null ) { return true; }
function esc_url_raw( $u ) { return $u; }
function esc_html__( $t, $d = '' ) { return $t; }
function wp_json_encode( $d ) { return json_encode( $d ); }
function get_woocommerce_currency() { return 'EUR'; }
function wc_get_price_decimals() { return 2; }
function wc_format_decimal( $n, $dp = false, $t = false ) {
	$n = str_replace( ',', '.', trim( (string) $n ) );
	return false !== $dp ? number_format( (float) $n, (int) $dp, '.', '' ) : $n;
}
function wc_get_logger() { return null; }
function is_wp_error( $t ) { return $t instanceof WP_Error; }
function wp_remote_retrieve_response_code( $r ) { return is_array( $r ) ? $r['response']['code'] : 0; }
function wp_remote_retrieve_body( $r ) { return is_array( $r ) ? $r['body'] : ''; }

class WP_Error {
	private $msg;
	public function __construct( $code, $msg ) { $this->msg = $msg; }
	public function get_error_message() { return $this->msg; }
}

class WP_User {
	public $ID = 7;
	public $user_login = 'jurian';
	public $user_email = 'jurian@example.com';
	public $roles = array( 'administrator' );
}
function wp_get_current_user() { return new WP_User(); }

/** Real HTTP via cURL, mirroring how WP_Http behaves for our arguments. */
function wc_audit_http( $url, $args, $method ) {
	$ch = curl_init( $url );
	curl_setopt_array( $ch, array(
		CURLOPT_CUSTOMREQUEST  => $method,
		CURLOPT_RETURNTRANSFER => true,
		CURLOPT_TIMEOUT        => isset( $args['timeout'] ) ? $args['timeout'] : 15,
		CURLOPT_FOLLOWLOCATION => ! empty( $args['redirection'] ),
		CURLOPT_MAXREDIRS      => isset( $args['redirection'] ) ? $args['redirection'] : 0,
		CURLOPT_POSTREDIR      => 7, // Preserve POST across 301/302/303 like a 308.
	) );

	$headers = array();
	foreach ( (array) ( isset( $args['headers'] ) ? $args['headers'] : array() ) as $k => $v ) {
		$headers[] = $k . ': ' . $v;
	}
	curl_setopt( $ch, CURLOPT_HTTPHEADER, $headers );

	if ( isset( $args['body'] ) ) {
		curl_setopt( $ch, CURLOPT_POSTFIELDS, $args['body'] );
	}

	$body = curl_exec( $ch );
	if ( false === $body ) {
		$err = curl_error( $ch );
		curl_close( $ch );
		return new WP_Error( 'http_request_failed', $err );
	}
	$code = curl_getinfo( $ch, CURLINFO_RESPONSE_CODE );
	curl_close( $ch );

	return array( 'response' => array( 'code' => $code ), 'body' => $body );
}
function wp_remote_post( $url, $args ) { return wc_audit_http( $url, $args, 'POST' ); }
function wp_remote_get( $url, $args ) { return wc_audit_http( $url, $args, 'GET' ); }

define( 'WC_AUDIT_LOGGER_ENDPOINT', $GLOBALS['endpoint'] );
define( 'WC_AUDIT_LOGGER_SECRET', $GLOBALS['secret'] );
define( 'WC_AUDIT_LOGGER_BLOCKING', true );

require __DIR__ . '/../wordpress/wc-audit-logger.php';

$probe = WC_Audit_Logger::probe();
echo "probe      : ok=" . var_export( $probe['ok'], true ) . " code=" . var_export( $probe['code'], true ) . "\n";
echo "             " . $probe['message'] . "\n";

$event = WC_Audit_Logger::send_test_event();
echo "test event : ok=" . var_export( $event['ok'], true ) . " code=" . var_export( $event['code'], true ) . "\n";
echo "             " . $event['message'] . "\n";
