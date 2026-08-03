<?php
/**
 * Harness that stubs just enough WordPress/WooCommerce to exercise the plugin's
 * capture -> dispatch pipeline and assert on the payload that would be POSTed.
 */

define( 'ABSPATH', '/tmp/wp/' );

$GLOBALS['sent'] = array();

function add_action( $hook, $cb, $prio = 10, $args = 1 ) {}
function apply_filters( $filter, $value ) { return $value; }
function home_url( $path = '' ) { return 'https://shop.example.com' . $path; }
function admin_url( $path = '' ) { return 'https://shop.example.com/wp-admin/' . $path; }
function is_admin() { return true; }
function is_user_logged_in() { return true; }
function wp_doing_cron() { return false; }
function wp_doing_ajax() { return false; }
function current_user_can( $cap ) { return true; }
function get_option( $name, $default = '' ) { return $default; }
function esc_url_raw( $url ) { return $url; }
function esc_html__( $t, $d = '' ) { return $t; }
function wp_json_encode( $data ) { return json_encode( $data ); }
function is_wp_error( $thing ) { return false; }
function get_woocommerce_currency() { return 'EUR'; }
function wc_get_price_decimals() { return 2; }
function wc_format_decimal( $number, $dp = false, $trim_zeros = false ) {
	$number = str_replace( ',', '.', trim( (string) $number ) );
	if ( false !== $dp ) {
		return number_format( (float) $number, (int) $dp, '.', '' );
	}
	if ( true === $trim_zeros && strstr( $number, '.' ) ) {
		$number = rtrim( rtrim( $number, '0' ), '.' );
	}
	return $number;
}
function wp_remote_post( $url, $args ) {
	$GLOBALS['sent'][] = array( 'url' => $url, 'args' => $args );
	return array( 'response' => array( 'code' => 202 ) );
}
function wc_get_logger() { return null; }
$GLOBALS['options'] = array();
function update_option( $name, $value, $autoload = null ) { $GLOBALS['options'][ $name ] = $value; return true; }
function wp_remote_retrieve_response_code( $r ) { return isset( $r['response']['code'] ) ? $r['response']['code'] : 0; }
function wp_remote_retrieve_body( $r ) { return isset( $r['body'] ) ? $r['body'] : ''; }
function wp_remote_get( $url, $args ) { $GLOBALS['sent'][] = array( 'url' => $url, 'args' => $args ); return array( 'response' => array( 'code' => 200 ), 'body' => '{"success":true,"ready":true}' ); }

class WP_User {
	public $ID = 7;
	public $user_login = 'jurian';
	public $user_email = 'jurian@example.com';
	public $roles = array( 'administrator' );
}
function wp_get_current_user() { return new WP_User(); }

/** Minimal WC_Product mirroring WC_Data's data/changes split. */
class WC_Product {
	protected $id = 0;
	protected $data = array();
	protected $changes = array();

	public function __construct( $id, array $data, array $changes ) {
		$this->id      = $id;
		$this->data    = $data;
		$this->changes = $changes;
	}
	public function get_id() { return $this->id; }
	public function set_id( $id ) { $this->id = $id; }
	public function get_changes() { return $this->changes; }
	public function get_data() { return array_merge( array( 'id' => $this->id ), $this->data ); }
	public function get_parent_id() { return isset( $this->data['parent_id'] ) ? $this->data['parent_id'] : 0; }
	public function get_sku() { return isset( $this->data['sku'] ) ? $this->data['sku'] : ''; }
	public function get_name() { return isset( $this->data['name'] ) ? $this->data['name'] : ''; }
	public function get_permalink() { return 'https://shop.example.com/product/' . $this->get_sku(); }
	public function get_status( $ctx = 'view' ) {
		return isset( $this->changes['status'] ) ? $this->changes['status'] : ( isset( $this->data['status'] ) ? $this->data['status'] : 'publish' );
	}
	/** Emulates WC_Data::save() applying changes after the data store runs. */
	public function apply_changes() {
		$this->data    = array_merge( $this->data, $this->changes );
		$this->changes = array();
	}
}

// Configured WITH a trailing slash on purpose: Next.js answers those with a
// 308, so the plugin must strip it before sending.
define( 'WC_AUDIT_LOGGER_ENDPOINT', 'https://audit.example.com/api/logs/product-change/' );
define( 'WC_AUDIT_LOGGER_SECRET', 'super-secret' );

require __DIR__ . '/../wordpress/wc-audit-logger.php';

$failures = 0;
function check( $label, $actual, $expected ) {
	global $failures;
	$ok = json_encode( $actual ) === json_encode( $expected );
	if ( ! $ok ) {
		$failures++;
		echo "FAIL: $label\n  expected: " . json_encode( $expected ) . "\n  actual:   " . json_encode( $actual ) . "\n";
	} else {
		echo "ok: $label\n";
	}
}

/* --- Case 1: price + stock + status + visibility change on an existing product --- */
$base = array(
	'name' => 'Blue Shirt', 'sku' => 'SHIRT-01', 'parent_id' => 0,
	'status' => 'draft', 'catalog_visibility' => 'visible',
	'regular_price' => '19.99', 'sale_price' => '', 'price' => '19.99',
	'stock_quantity' => 10, 'stock_status' => 'instock', 'manage_stock' => true,
);
$product = new WC_Product( 123, $base, array(
	'regular_price' => '24.99', 'sale_price' => '20.00', 'price' => '20.00',
	'stock_quantity' => 4, 'stock_status' => 'outofstock',
	'status' => 'publish', 'catalog_visibility' => 'hidden',
) );

WC_Audit_Logger::capture( $product );
$product->apply_changes();            // WooCommerce wipes changes during save.
check( 'changes cleared by save', $product->get_changes(), array() );
WC_Audit_Logger::dispatch( $product );

check( 'one request sent', count( $GLOBALS['sent'] ), 1 );
$payload = json_decode( $GLOBALS['sent'][0]['args']['body'], true );

check( 'non-blocking', $GLOBALS['sent'][0]['args']['blocking'], false );
check( 'secret header', $GLOBALS['sent'][0]['args']['headers']['X-Api-Secret'], 'super-secret' );
check( 'product_id', $payload['product_id'], 123 );
check( 'sku', $payload['sku'], 'SHIRT-01' );
check( 'admin', $payload['admin'], array( 'id' => 7, 'user' => 'jurian', 'email' => 'jurian@example.com', 'roles' => array( 'administrator' ) ) );
check( 'is_new', $payload['is_new'], false );
check( 'price delta', $payload['changes']['price'], array(
	'regular_price' => array( 'from' => '19.99', 'to' => '24.99' ),
	'sale_price'    => array( 'from' => '', 'to' => '20.00' ),
) );
check( 'stock delta', $payload['changes']['stock'], array(
	'stock_quantity' => array( 'from' => 10, 'to' => 4 ),
	'stock_status'   => array( 'from' => 'instock', 'to' => 'outofstock' ),
) );
check( 'status delta', $payload['changes']['status'], array( 'from' => 'draft', 'to' => 'publish' ) );
check( 'visibility delta', $payload['changes']['catalog_visibility'], array( 'from' => 'visible', 'to' => 'hidden' ) );

/* --- Case 2: cosmetic price change (19.9 -> 19.90) must not be logged --- */
$GLOBALS['sent'] = array();
$p2 = new WC_Product( 200, array_merge( $base, array( 'regular_price' => '19.9' ) ), array( 'regular_price' => '19.90' ) );
WC_Audit_Logger::capture( $p2 );
WC_Audit_Logger::dispatch( $p2 );
check( 'cosmetic change ignored', count( $GLOBALS['sent'] ), 0 );

/* --- Case 3: untracked prop only (description) must not be logged --- */
$GLOBALS['sent'] = array();
$p3 = new WC_Product( 201, $base, array( 'description' => 'new copy' ) );
WC_Audit_Logger::capture( $p3 );
WC_Audit_Logger::dispatch( $p3 );
check( 'untracked prop ignored', count( $GLOBALS['sent'] ), 0 );

/* --- Case 4: auto-draft skipped --- */
$GLOBALS['sent'] = array();
$p4 = new WC_Product( 0, array_merge( $base, array( 'status' => 'draft' ) ), array( 'status' => 'auto-draft', 'regular_price' => '5.00' ) );
WC_Audit_Logger::capture( $p4 );
WC_Audit_Logger::dispatch( $p4 );
check( 'auto-draft skipped', count( $GLOBALS['sent'] ), 0 );

/* --- Case 5: new product gets its ID at dispatch time --- */
$GLOBALS['sent'] = array();
$p5 = new WC_Product( 0, $base, array( 'status' => 'publish', 'regular_price' => '30.00' ) );
WC_Audit_Logger::capture( $p5 );
$p5->set_id( 999 );                   // Data store assigns the ID during save.
$p5->apply_changes();
WC_Audit_Logger::dispatch( $p5 );
check( 'new product sent', count( $GLOBALS['sent'] ), 1 );
$p5payload = json_decode( $GLOBALS['sent'][0]['args']['body'], true );
check( 'new product id resolved', $p5payload['product_id'], 999 );
check( 'new product flagged', $p5payload['is_new'], true );

/* --- Case 6: manage_stock toggle --- */
$GLOBALS['sent'] = array();
$p6 = new WC_Product( 300, $base, array( 'manage_stock' => false, 'stock_quantity' => null ) );
WC_Audit_Logger::capture( $p6 );
WC_Audit_Logger::dispatch( $p6 );
$p6payload = json_decode( $GLOBALS['sent'][0]['args']['body'], true );
check( 'manage_stock delta', $p6payload['changes']['stock'], array(
	'stock_quantity' => array( 'from' => 10, 'to' => null ),
	'manage_stock'   => array( 'from' => true, 'to' => false ),
) );

/* --- Case 7: dispatch without capture sends nothing --- */
$GLOBALS['sent'] = array();
$p7 = new WC_Product( 400, $base, array() );
WC_Audit_Logger::dispatch( $p7 );
check( 'no stash, no send', count( $GLOBALS['sent'] ), 0 );

/* --- Case 8: transport hardening --- */
$GLOBALS['sent'] = array();
$p8 = new WC_Product( 500, $base, array( 'regular_price' => '99.00' ) );
WC_Audit_Logger::capture( $p8 );
WC_Audit_Logger::dispatch( $p8 );
$args8 = $GLOBALS['sent'][0]['args'];
check( 'follows redirects', $args8['redirection'], 3 );
check( 'timeout raised', $args8['timeout'], 5 );
check( 'endpoint has no trailing slash', $GLOBALS['sent'][0]['url'], 'https://audit.example.com/api/logs/product-change' );
check( 'attempt recorded', isset( $GLOBALS['options']['wc_audit_logger_last_attempt'] ), true );
check( 'attempt has product id', $GLOBALS['options']['wc_audit_logger_last_attempt']['product_id'], 500 );

/* --- Case 9: trailing slash in the configured endpoint is stripped --- */
check( 'get_endpoint normalises', WC_Audit_Logger::get_endpoint(), 'https://audit.example.com/api/logs/product-change' );

/* --- Case 10: blocking probe reports the real status --- */
$GLOBALS['sent'] = array();
$probe = WC_Audit_Logger::probe();
check( 'probe ok', $probe['ok'], true );
check( 'probe code', $probe['code'], 200 );

echo $failures ? "\n$failures FAILURE(S)\n" : "\nAll PHP checks passed.\n";
exit( $failures ? 1 : 0 );
