<?php
/**
 * Plugin Name:       WC Audit Logger Bridge
 * Plugin URI:        https://github.com/jurian360/woocommerce-logger
 * Description:       Sends product price, stock, status and catalog-visibility changes made by administrators to an external Next.js audit-log endpoint.
 * Version:           1.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * WC requires at least: 7.0
 * WC tested up to:   10.9
 * Author:            jurian360
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       wc-audit-logger
 *
 * ---------------------------------------------------------------------------
 * CONFIGURATION — add to wp-config.php, ABOVE the "That's all, stop editing"
 * line:
 *
 *     define( 'WC_AUDIT_LOGGER_ENDPOINT', 'https://your-app.vercel.app/api/logs/product-change' );
 *     define( 'WC_AUDIT_LOGGER_SECRET',   'the same value as API_SECRET in Vercel' );
 *
 * Optional:
 *
 *     // Log every decision and every HTTP response to WooCommerce > Status > Logs.
 *     define( 'WC_AUDIT_LOGGER_DEBUG', true );
 *
 *     // Wait for the response instead of firing and forgetting. Slower saves,
 *     // but some hosts drop non-blocking requests entirely. Turn this on if
 *     // the status page says events are being sent but nothing arrives.
 *     define( 'WC_AUDIT_LOGGER_BLOCKING', true );
 *
 * All of these fall back to the `wc_audit_logger_*` options and can be
 * overridden with the filters of the same name.
 *
 * TROUBLESHOOTING: go to WooCommerce > Audit Logger. That screen shows the
 * resolved configuration, when an event was last sent, and gives you buttons to
 * test the connection and send a synthetic event — each reporting the real HTTP
 * status code.
 *
 * Installation: drop this file in wp-content/plugins/wc-audit-logger/ and
 * activate it, or place it in wp-content/mu-plugins/ to have it always on.
 * ---------------------------------------------------------------------------
 *
 * @package WC_Audit_Logger
 */

defined( 'ABSPATH' ) || exit;

if ( ! class_exists( 'WC_Audit_Logger', false ) ) :

	/**
	 * Captures product changes and forwards them to the audit API.
	 */
	final class WC_Audit_Logger {

		const VERSION = '1.1.0';

		/** Option holding a short record of the last dispatch attempt. */
		const LAST_ATTEMPT_OPTION = 'wc_audit_logger_last_attempt';

		/**
		 * Pending diffs, keyed by spl_object_id() of the product being saved.
		 *
		 * WooCommerce clears `$product->get_changes()` while saving, so the diff
		 * is computed on the *before* hook and dispatched on the *after* hook.
		 * That also guarantees a real product ID for newly created products.
		 *
		 * @var array<int, array<string, mixed>>
		 */
		private static $pending = array();

		/**
		 * Product properties we care about, mapped to their payload group.
		 *
		 * @return array<string, string>
		 */
		private static function tracked_props() {
			$props = array(
				'regular_price'      => 'price',
				'sale_price'         => 'price',
				'stock_quantity'     => 'stock',
				'stock_status'       => 'stock',
				'manage_stock'       => 'stock',
				'status'             => 'status',
				'catalog_visibility' => 'catalog_visibility',
			);

			/**
			 * Filter the tracked properties.
			 *
			 * @param array<string, string> $props Map of WC_Product prop => payload group.
			 */
			return (array) apply_filters( 'wc_audit_logger_tracked_props', $props );
		}

		/**
		 * Register hooks.
		 *
		 * @return void
		 */
		public static function init() {
			// Products.
			add_action( 'woocommerce_before_product_object_save', array( __CLASS__, 'capture' ), 10, 1 );
			add_action( 'woocommerce_after_product_object_save', array( __CLASS__, 'dispatch' ), 10, 1 );

			// Variations use their own object type in WC_Product::save().
			add_action( 'woocommerce_before_product_variation_object_save', array( __CLASS__, 'capture' ), 10, 1 );
			add_action( 'woocommerce_after_product_variation_object_save', array( __CLASS__, 'dispatch' ), 10, 1 );

			add_action( 'admin_menu', array( __CLASS__, 'register_admin_page' ) );
			add_action( 'admin_init', array( __CLASS__, 'handle_admin_actions' ) );
			add_action( 'admin_notices', array( __CLASS__, 'maybe_render_config_notice' ) );
		}

		/* -------------------------------------------------------------------
		 * Capture / dispatch
		 * ---------------------------------------------------------------- */

		/**
		 * Snapshot the diff before WooCommerce applies (and discards) the changes.
		 *
		 * @param WC_Product $product Product being saved.
		 * @return void
		 */
		public static function capture( $product ) {
			if ( ! $product instanceof WC_Product ) {
				return;
			}

			$blocked = self::blocked_reason();

			if ( null !== $blocked ) {
				self::debug( 'Skipped: ' . $blocked );
				return;
			}

			$changes = $product->get_changes();

			if ( empty( $changes ) ) {
				self::debug( 'Skipped: product has no pending changes.' );
				return;
			}

			// `get_data()` returns the persisted values; `get_changes()` the new ones.
			$old  = $product->get_data();
			$diff = self::build_diff( $old, $changes );

			if ( empty( $diff ) ) {
				self::debug(
					'Skipped: none of the changed properties are tracked (changed: '
					. implode( ', ', array_keys( $changes ) ) . ').'
				);
				return;
			}

			// Ignore the auto-draft rows WordPress creates when you click "Add product".
			$new_status = isset( $changes['status'] ) ? $changes['status'] : $product->get_status( 'edit' );
			if ( 'auto-draft' === $new_status ) {
				self::debug( 'Skipped: product is an auto-draft.' );
				return;
			}

			self::$pending[ spl_object_id( $product ) ] = array(
				'changes' => $diff,
				'is_new'  => ! $product->get_id(),
			);
		}

		/**
		 * Send the captured diff once the save succeeded.
		 *
		 * @param WC_Product $product Saved product.
		 * @return void
		 */
		public static function dispatch( $product ) {
			if ( ! $product instanceof WC_Product ) {
				return;
			}

			$key = spl_object_id( $product );

			if ( ! isset( self::$pending[ $key ] ) ) {
				return;
			}

			$captured = self::$pending[ $key ];
			unset( self::$pending[ $key ] );

			$product_id = $product->get_id();

			if ( ! $product_id ) {
				self::debug( 'Skipped: product has no ID after save.' );
				return;
			}

			$payload = self::build_payload( $product, $captured['changes'], (bool) $captured['is_new'] );

			/**
			 * Filter the payload before it is sent.
			 *
			 * @param array      $payload Payload to POST.
			 * @param WC_Product $product Saved product.
			 */
			$payload = apply_filters( 'wc_audit_logger_payload', $payload, $product );

			self::send( $payload );
		}

		/**
		 * Assemble the request body for a product.
		 *
		 * @param WC_Product           $product Saved product.
		 * @param array<string, mixed> $changes Diff produced by build_diff().
		 * @param bool                 $is_new  Whether the save created the product.
		 * @return array<string, mixed>
		 */
		private static function build_payload( $product, array $changes, $is_new ) {
			$user       = wp_get_current_user();
			$product_id = $product->get_id();

			return array(
				'product_id' => (int) $product_id,
				'parent_id'  => (int) $product->get_parent_id(),
				'sku'        => (string) $product->get_sku(),
				'name'       => (string) $product->get_name(),
				'currency'   => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : '',
				'site'       => home_url(),
				'source'     => self::request_source(),
				'permalink'  => (string) $product->get_permalink(),
				'edit_link'  => admin_url( 'post.php?post=' . $product_id . '&action=edit' ),
				'is_new'     => (bool) $is_new,
				'admin'      => array(
					'id'    => (int) $user->ID,
					'user'  => (string) $user->user_login,
					'email' => (string) $user->user_email,
					'roles' => array_values( (array) $user->roles ),
				),
				'timestamp'  => gmdate( 'c' ),
				'changes'    => $changes,
			);
		}

		/**
		 * Build the grouped `{ from, to }` diff for the tracked properties.
		 *
		 * @param array<string, mixed> $old     Persisted product data.
		 * @param array<string, mixed> $changes Pending changes.
		 * @return array<string, mixed>
		 */
		private static function build_diff( array $old, array $changes ) {
			$diff = array();

			foreach ( self::tracked_props() as $prop => $group ) {
				if ( ! array_key_exists( $prop, $changes ) ) {
					continue;
				}

				$from = array_key_exists( $prop, $old ) ? $old[ $prop ] : null;
				$to   = $changes[ $prop ];

				if ( self::values_match( $prop, $from, $to ) ) {
					continue;
				}

				$delta = array(
					'from' => self::normalize_value( $prop, $from ),
					'to'   => self::normalize_value( $prop, $to ),
				);

				// `status` and `catalog_visibility` are single values, so they are
				// stored flat; `price` and `stock` group several props together.
				if ( $prop === $group ) {
					$diff[ $group ] = $delta;
				} else {
					if ( ! isset( $diff[ $group ] ) ) {
						$diff[ $group ] = array();
					}
					$diff[ $group ][ $prop ] = $delta;
				}
			}

			return $diff;
		}

		/**
		 * Compare old/new values, ignoring cosmetic differences.
		 *
		 * WooCommerce happily reports "19.9" -> "19.90" as a change; those are not
		 * worth an audit row.
		 *
		 * @param string $prop Property name.
		 * @param mixed  $from Old value.
		 * @param mixed  $to   New value.
		 * @return bool True when the values are equivalent.
		 */
		private static function values_match( $prop, $from, $to ) {
			if ( in_array( $prop, array( 'regular_price', 'sale_price' ), true ) ) {
				$decimals = function_exists( 'wc_get_price_decimals' ) ? wc_get_price_decimals() : 2;

				$from_clean = ( '' === $from || null === $from ) ? '' : wc_format_decimal( $from, $decimals );
				$to_clean   = ( '' === $to || null === $to ) ? '' : wc_format_decimal( $to, $decimals );

				return $from_clean === $to_clean;
			}

			if ( 'stock_quantity' === $prop ) {
				$from_clean = ( null === $from || '' === $from ) ? null : (float) $from;
				$to_clean   = ( null === $to || '' === $to ) ? null : (float) $to;

				return $from_clean === $to_clean;
			}

			if ( 'manage_stock' === $prop ) {
				return (bool) $from === (bool) $to;
			}

			// Loose scalars are compared as strings to avoid "0" vs 0 noise.
			if ( is_scalar( $from ) || null === $from ) {
				return (string) $from === (string) $to;
			}

			return $from === $to;
		}

		/**
		 * Cast a value into something that survives JSON encoding cleanly.
		 *
		 * @param string $prop  Property name.
		 * @param mixed  $value Raw value.
		 * @return mixed
		 */
		private static function normalize_value( $prop, $value ) {
			if ( 'manage_stock' === $prop ) {
				return (bool) $value;
			}

			if ( 'stock_quantity' === $prop ) {
				return ( null === $value || '' === $value ) ? null : (float) $value;
			}

			if ( in_array( $prop, array( 'regular_price', 'sale_price' ), true ) ) {
				if ( null === $value || '' === $value ) {
					return '';
				}

				// Normalise to the shop's decimal precision so the dashboard shows
				// "19.90" rather than "19.9" for the same underlying amount.
				$decimals = function_exists( 'wc_get_price_decimals' ) ? wc_get_price_decimals() : 2;

				return (string) wc_format_decimal( $value, $decimals );
			}

			if ( is_scalar( $value ) ) {
				return $value;
			}

			return null === $value ? null : wp_json_encode( $value );
		}

		/**
		 * Why the current request must not be logged, or null when it may be.
		 *
		 * Only interactive changes by a user who can edit products are recorded —
		 * CRON, WP-CLI, imports and unauthenticated requests are ignored.
		 *
		 * @return string|null Human-readable reason, or null to proceed.
		 */
		private static function blocked_reason() {
			if ( defined( 'WP_CLI' ) && WP_CLI ) {
				return 'running under WP-CLI';
			}

			if ( function_exists( 'wp_doing_cron' ) ? wp_doing_cron() : ( defined( 'DOING_CRON' ) && DOING_CRON ) ) {
				return 'running during WP-Cron';
			}

			if ( defined( 'WP_IMPORTING' ) && WP_IMPORTING ) {
				return 'running during an import';
			}

			if ( ! function_exists( 'is_user_logged_in' ) || ! is_user_logged_in() ) {
				return 'no logged-in user for this request';
			}

			if ( ! current_user_can( 'edit_products' ) ) {
				return 'current user lacks the edit_products capability';
			}

			if ( '' === self::get_endpoint() ) {
				return 'no endpoint configured (WC_AUDIT_LOGGER_ENDPOINT)';
			}

			if ( '' === self::get_secret() ) {
				return 'no secret configured (WC_AUDIT_LOGGER_SECRET)';
			}

			/**
			 * Final say on whether this request is logged.
			 *
			 * @param bool $should_log Current decision.
			 */
			if ( ! apply_filters( 'wc_audit_logger_should_log', true ) ) {
				return 'blocked by the wc_audit_logger_should_log filter';
			}

			return null;
		}

		/**
		 * Best-effort label for where the change came from.
		 *
		 * @return string
		 */
		private static function request_source() {
			if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
				return 'rest';
			}

			if ( function_exists( 'wp_doing_ajax' ) && wp_doing_ajax() ) {
				return 'ajax';
			}

			if ( is_admin() ) {
				return 'admin';
			}

			return 'frontend';
		}

		/* -------------------------------------------------------------------
		 * Transport
		 * ---------------------------------------------------------------- */

		/**
		 * POST the payload to the audit API.
		 *
		 * Non-blocking by default so the admin screen never waits. In blocking or
		 * debug mode the real status code is returned and logged, which is the
		 * only way to see a 401/404/redirect — a fire-and-forget request discards
		 * the response, so every failure looks identical to success.
		 *
		 * @param array<string, mixed> $payload        Payload to send.
		 * @param bool                 $force_blocking Wait for the response regardless of config.
		 * @return array{ok: bool, code: int|null, message: string} Result summary.
		 */
		private static function send( array $payload, $force_blocking = false ) {
			$endpoint = self::get_endpoint();
			$secret   = self::get_secret();

			if ( '' === $endpoint || '' === $secret ) {
				return array(
					'ok'      => false,
					'code'    => null,
					'message' => 'Endpoint or secret is not configured.',
				);
			}

			$body = wp_json_encode( $payload );

			if ( false === $body ) {
				$message = 'Could not JSON-encode the audit payload.';
				self::log_error( $message );

				return array(
					'ok'      => false,
					'code'    => null,
					'message' => $message,
				);
			}

			$blocking = $force_blocking || self::is_blocking() || self::is_debug();

			$response = wp_remote_post(
				$endpoint,
				array(
					'method'      => 'POST',
					'blocking'    => $blocking,
					// Long enough to survive a TLS handshake plus a serverless cold
					// start. A non-blocking request that times out mid-handshake
					// never reaches the server at all.
					'timeout'     => $blocking ? 15 : 5,
					// Follow redirects: a trailing slash on the endpoint makes
					// Next.js answer 308, and a redirect that is not followed is
					// silently dropped.
					'redirection' => 3,
					'httpversion' => '1.1',
					'sslverify'   => (bool) apply_filters( 'wc_audit_logger_sslverify', true ),
					'headers'     => array(
						'Content-Type' => 'application/json; charset=utf-8',
						'Accept'       => 'application/json',
						'X-Api-Secret' => $secret,
						'User-Agent'   => 'WC-Audit-Logger/' . self::VERSION . '; ' . home_url(),
					),
					'body'        => $body,
					'data_format' => 'body',
				)
			);

			$result = self::interpret_response( $response, $blocking );

			self::record_attempt(
				array(
					'time'       => time(),
					'product_id' => isset( $payload['product_id'] ) ? (int) $payload['product_id'] : 0,
					'blocking'   => $blocking,
					'ok'         => $result['ok'],
					'code'       => $result['code'],
					'message'    => $result['message'],
				)
			);

			if ( ! $result['ok'] ) {
				self::log_error( $result['message'] );
			} else {
				self::debug( 'Sent: ' . $result['message'] );
			}

			return $result;
		}

		/**
		 * Turn a wp_remote_* return value into a plain result summary.
		 *
		 * @param array|WP_Error $response Response from the HTTP API.
		 * @param bool           $blocking Whether the request waited for a response.
		 * @return array{ok: bool, code: int|null, message: string}
		 */
		private static function interpret_response( $response, $blocking ) {
			if ( is_wp_error( $response ) ) {
				return array(
					'ok'      => false,
					'code'    => null,
					'message' => 'Request failed: ' . $response->get_error_message(),
				);
			}

			if ( ! $blocking ) {
				// The response was discarded by design; delivery is unconfirmed.
				return array(
					'ok'      => true,
					'code'    => null,
					'message' => 'Sent without waiting for a response (delivery unconfirmed).',
				);
			}

			$code = (int) wp_remote_retrieve_response_code( $response );
			$body = (string) wp_remote_retrieve_body( $response );

			if ( $code >= 200 && $code < 300 ) {
				return array(
					'ok'      => true,
					'code'    => $code,
					'message' => sprintf( 'HTTP %d — %s', $code, self::truncate( $body ) ),
				);
			}

			return array(
				'ok'      => false,
				'code'    => $code,
				'message' => sprintf( 'HTTP %d — %s%s', $code, self::truncate( $body ), self::explain_status( $code ) ),
			);
		}

		/**
		 * Plain-language hint for the status codes this API can return.
		 *
		 * @param int $code HTTP status code.
		 * @return string
		 */
		private static function explain_status( $code ) {
			switch ( $code ) {
				case 401:
					return ' | The secret does not match API_SECRET on the server.';
				case 404:
					return ' | Wrong URL. It must end in /api/logs/product-change.';
				case 405:
					return ' | The URL resolved to a route that does not accept POST.';
				case 413:
					return ' | Payload larger than the 64 KB limit.';
				case 500:
					return ' | Server error: API_SECRET missing on the server, or the MongoDB write failed.';
				default:
					if ( $code >= 300 && $code < 400 ) {
						return ' | Unfollowed redirect. Check for a trailing slash or a www/non-www mismatch.';
					}

					return '';
			}
		}

		/**
		 * Verify connectivity with a blocking GET against the health probe.
		 *
		 * @return array{ok: bool, code: int|null, message: string}
		 */
		public static function probe() {
			$endpoint = self::get_endpoint();
			$secret   = self::get_secret();

			if ( '' === $endpoint || '' === $secret ) {
				return array(
					'ok'      => false,
					'code'    => null,
					'message' => 'Endpoint or secret is not configured.',
				);
			}

			$response = wp_remote_get(
				$endpoint,
				array(
					'timeout'     => 15,
					'redirection' => 3,
					'httpversion' => '1.1',
					'sslverify'   => (bool) apply_filters( 'wc_audit_logger_sslverify', true ),
					'headers'     => array(
						'Accept'       => 'application/json',
						'X-Api-Secret' => $secret,
						'User-Agent'   => 'WC-Audit-Logger/' . self::VERSION . '; ' . home_url(),
					),
				)
			);

			return self::interpret_response( $response, true );
		}

		/**
		 * Send a synthetic event, waiting for the response.
		 *
		 * @return array{ok: bool, code: int|null, message: string}
		 */
		public static function send_test_event() {
			$user = wp_get_current_user();

			$payload = array(
				'product_id' => 0,
				'sku'        => 'AUDIT-LOGGER-TEST',
				'name'       => 'Audit logger test event',
				'currency'   => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : '',
				'site'       => home_url(),
				'source'     => 'test',
				'is_new'     => false,
				'admin'      => array(
					'id'    => (int) $user->ID,
					'user'  => (string) $user->user_login,
					'email' => (string) $user->user_email,
					'roles' => array_values( (array) $user->roles ),
				),
				'timestamp'  => gmdate( 'c' ),
				'changes'    => array(
					'status' => array(
						'from' => 'draft',
						'to'   => 'publish',
					),
				),
			);

			return self::send( $payload, true );
		}

		/* -------------------------------------------------------------------
		 * Configuration
		 * ---------------------------------------------------------------- */

		/**
		 * Endpoint URL, normalised.
		 *
		 * A trailing slash is stripped: Next.js answers `/api/.../` with a 308
		 * redirect, and a redirect the HTTP API does not follow means the event
		 * is silently lost.
		 *
		 * @return string
		 */
		public static function get_endpoint() {
			$endpoint = defined( 'WC_AUDIT_LOGGER_ENDPOINT' )
				? WC_AUDIT_LOGGER_ENDPOINT
				: get_option( 'wc_audit_logger_endpoint', '' );

			/** @param string $endpoint Audit API endpoint. */
			$endpoint = (string) apply_filters( 'wc_audit_logger_endpoint', $endpoint );
			$endpoint = trim( $endpoint );

			if ( '' === $endpoint ) {
				return '';
			}

			return esc_url_raw( rtrim( $endpoint, '/' ) );
		}

		/**
		 * Shared secret.
		 *
		 * @return string
		 */
		public static function get_secret() {
			$secret = defined( 'WC_AUDIT_LOGGER_SECRET' )
				? WC_AUDIT_LOGGER_SECRET
				: get_option( 'wc_audit_logger_secret', '' );

			/** @param string $secret Shared secret for the X-Api-Secret header. */
			return trim( (string) apply_filters( 'wc_audit_logger_secret', $secret ) );
		}

		/**
		 * Whether verbose logging is on.
		 *
		 * @return bool
		 */
		public static function is_debug() {
			$debug = defined( 'WC_AUDIT_LOGGER_DEBUG' )
				? (bool) WC_AUDIT_LOGGER_DEBUG
				: (bool) get_option( 'wc_audit_logger_debug', false );

			/** @param bool $debug Whether to log verbosely. */
			return (bool) apply_filters( 'wc_audit_logger_debug', $debug );
		}

		/**
		 * Whether product saves wait for the audit API's response.
		 *
		 * @return bool
		 */
		public static function is_blocking() {
			$blocking = defined( 'WC_AUDIT_LOGGER_BLOCKING' )
				? (bool) WC_AUDIT_LOGGER_BLOCKING
				: (bool) get_option( 'wc_audit_logger_blocking', false );

			/** @param bool $blocking Whether to wait for the response. */
			return (bool) apply_filters( 'wc_audit_logger_blocking', $blocking );
		}

		/* -------------------------------------------------------------------
		 * Admin screen
		 * ---------------------------------------------------------------- */

		/**
		 * Add the status screen under the WooCommerce menu.
		 *
		 * @return void
		 */
		public static function register_admin_page() {
			add_submenu_page(
				'woocommerce',
				__( 'Audit Logger', 'wc-audit-logger' ),
				__( 'Audit Logger', 'wc-audit-logger' ),
				'manage_woocommerce',
				'wc-audit-logger',
				array( __CLASS__, 'render_admin_page' )
			);
		}

		/**
		 * Run the connection test / test event buttons.
		 *
		 * @return void
		 */
		public static function handle_admin_actions() {
			if ( ! isset( $_POST['wc_audit_logger_action'] ) ) {
				return;
			}

			if ( ! current_user_can( 'manage_woocommerce' ) ) {
				return;
			}

			check_admin_referer( 'wc_audit_logger_action' );

			$action = sanitize_key( wp_unslash( $_POST['wc_audit_logger_action'] ) );

			if ( 'probe' === $action ) {
				$result = self::probe();
			} elseif ( 'test_event' === $action ) {
				$result = self::send_test_event();
			} else {
				return;
			}

			set_transient( 'wc_audit_logger_result_' . get_current_user_id(), $result, 60 );

			wp_safe_redirect( admin_url( 'admin.php?page=wc-audit-logger' ) );
			exit;
		}

		/**
		 * Render the status screen.
		 *
		 * @return void
		 */
		public static function render_admin_page() {
			if ( ! current_user_can( 'manage_woocommerce' ) ) {
				return;
			}

			$endpoint = self::get_endpoint();
			$secret   = self::get_secret();
			$last     = get_option( self::LAST_ATTEMPT_OPTION, array() );

			$transient_key = 'wc_audit_logger_result_' . get_current_user_id();
			$result        = get_transient( $transient_key );

			if ( $result ) {
				delete_transient( $transient_key );
			}

			echo '<div class="wrap">';
			echo '<h1>' . esc_html__( 'WooCommerce Audit Logger', 'wc-audit-logger' ) . '</h1>';

			if ( is_array( $result ) ) {
				printf(
					'<div class="notice notice-%s"><p><strong>%s</strong> %s</p></div>',
					$result['ok'] ? 'success' : 'error',
					$result['ok'] ? esc_html__( 'Success:', 'wc-audit-logger' ) : esc_html__( 'Failed:', 'wc-audit-logger' ),
					esc_html( $result['message'] )
				);
			}

			echo '<h2>' . esc_html__( 'Configuration', 'wc-audit-logger' ) . '</h2>';
			echo '<table class="widefat striped" style="max-width:820px"><tbody>';

			self::render_row(
				__( 'Endpoint', 'wc-audit-logger' ),
				'' !== $endpoint ? $endpoint : __( 'not set', 'wc-audit-logger' ),
				'' !== $endpoint
			);

			self::render_row(
				__( 'Secret', 'wc-audit-logger' ),
				'' !== $secret
					/* translators: %d: number of characters in the configured secret. */
					? sprintf( __( 'set (%d characters)', 'wc-audit-logger' ), strlen( $secret ) )
					: __( 'not set', 'wc-audit-logger' ),
				'' !== $secret
			);

			self::render_row(
				__( 'Mode', 'wc-audit-logger' ),
				self::is_blocking() || self::is_debug()
					? __( 'blocking — saves wait for the response', 'wc-audit-logger' )
					: __( 'non-blocking — fire and forget', 'wc-audit-logger' ),
				true
			);

			self::render_row(
				__( 'Debug logging', 'wc-audit-logger' ),
				self::is_debug()
					? __( 'on — see WooCommerce > Status > Logs', 'wc-audit-logger' )
					: __( 'off', 'wc-audit-logger' ),
				true
			);

			if ( ! empty( $last['time'] ) ) {
				self::render_row(
					__( 'Last send attempt', 'wc-audit-logger' ),
					sprintf(
						/* translators: 1: human time diff, 2: product id, 3: outcome message. */
						__( '%1$s ago — product #%2$d — %3$s', 'wc-audit-logger' ),
						human_time_diff( (int) $last['time'], time() ),
						isset( $last['product_id'] ) ? (int) $last['product_id'] : 0,
						isset( $last['message'] ) ? $last['message'] : ''
					),
					! empty( $last['ok'] )
				);
			} else {
				self::render_row(
					__( 'Last send attempt', 'wc-audit-logger' ),
					__( 'never — no product change has reached the sender yet', 'wc-audit-logger' ),
					false
				);
			}

			echo '</tbody></table>';

			echo '<h2>' . esc_html__( 'Diagnostics', 'wc-audit-logger' ) . '</h2>';
			echo '<p>' . esc_html__(
				'Both buttons wait for the real response, so they report the actual HTTP status code.',
				'wc-audit-logger'
			) . '</p>';

			echo '<form method="post" style="display:inline-block;margin-right:8px">';
			wp_nonce_field( 'wc_audit_logger_action' );
			echo '<input type="hidden" name="wc_audit_logger_action" value="probe" />';
			submit_button( __( 'Test connection', 'wc-audit-logger' ), 'secondary', 'submit', false );
			echo '</form>';

			echo '<form method="post" style="display:inline-block">';
			wp_nonce_field( 'wc_audit_logger_action' );
			echo '<input type="hidden" name="wc_audit_logger_action" value="test_event" />';
			submit_button( __( 'Send test event', 'wc-audit-logger' ), 'primary', 'submit', false );
			echo '</form>';

			echo '<h2>' . esc_html__( 'If nothing arrives', 'wc-audit-logger' ) . '</h2>';
			echo '<ol>';
			echo '<li>' . esc_html__(
				'Press "Test connection". A 401 means the secret does not match; a 404 means the URL is wrong; a timeout means this host blocks outbound requests.',
				'wc-audit-logger'
			) . '</li>';
			echo '<li>' . esc_html__(
				'Press "Send test event". If that succeeds but editing a product logs nothing, the change was not one of the tracked fields, or the save did not come from a logged-in user with the edit_products capability.',
				'wc-audit-logger'
			) . '</li>';
			echo '<li>' . esc_html__(
				'If "Last send attempt" stays at "never" after editing a product price, enable WC_AUDIT_LOGGER_DEBUG and check WooCommerce > Status > Logs — every skipped save records its reason there.',
				'wc-audit-logger'
			) . '</li>';
			echo '</ol>';

			echo '</div>';
		}

		/**
		 * Render one row of the configuration table.
		 *
		 * @param string $label Row label.
		 * @param string $value Row value.
		 * @param bool   $ok    Whether to show the value as healthy.
		 * @return void
		 */
		private static function render_row( $label, $value, $ok ) {
			printf(
				'<tr><td style="width:200px"><strong>%s</strong></td><td><span style="color:%s">%s</span></td></tr>',
				esc_html( $label ),
				$ok ? '#1a7f37' : '#b32d2e',
				esc_html( $value )
			);
		}

		/**
		 * Warn administrators when the plugin is active but not configured.
		 *
		 * @return void
		 */
		public static function maybe_render_config_notice() {
			if ( ! current_user_can( 'manage_woocommerce' ) ) {
				return;
			}

			if ( '' !== self::get_endpoint() && '' !== self::get_secret() ) {
				return;
			}

			echo '<div class="notice notice-warning"><p><strong>WC Audit Logger:</strong> ';
			echo esc_html__(
				'no endpoint or secret configured, so product changes are not being logged. Define WC_AUDIT_LOGGER_ENDPOINT and WC_AUDIT_LOGGER_SECRET in wp-config.php.',
				'wc-audit-logger'
			);
			echo '</p></div>';
		}

		/* -------------------------------------------------------------------
		 * Logging
		 * ---------------------------------------------------------------- */

		/**
		 * Remember the outcome of the most recent dispatch attempt.
		 *
		 * This is what distinguishes "the hook never fired" from "it fired but the
		 * request did not arrive" — the single most useful fact when debugging.
		 *
		 * @param array<string, mixed> $attempt Attempt summary.
		 * @return void
		 */
		private static function record_attempt( array $attempt ) {
			update_option( self::LAST_ATTEMPT_OPTION, $attempt, false );
		}

		/**
		 * Shorten a response body for log and notice output.
		 *
		 * @param string $text  Text to shorten.
		 * @param int    $limit Maximum length.
		 * @return string
		 */
		private static function truncate( $text, $limit = 300 ) {
			$text = trim( preg_replace( '/\s+/', ' ', $text ) );

			if ( '' === $text ) {
				return '(empty body)';
			}

			if ( strlen( $text ) <= $limit ) {
				return $text;
			}

			return substr( $text, 0, $limit ) . '…';
		}

		/**
		 * Verbose log line, only written when debugging is on.
		 *
		 * @param string $message Message to record.
		 * @return void
		 */
		private static function debug( $message ) {
			if ( ! self::is_debug() ) {
				return;
			}

			if ( function_exists( 'wc_get_logger' ) ) {
				$logger = wc_get_logger();

				if ( $logger ) {
					$logger->info( $message, array( 'source' => 'wc-audit-logger' ) );
					return;
				}
			}

			if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
				// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
				error_log( '[wc-audit-logger] ' . $message );
			}
		}

		/**
		 * Write to the WooCommerce logger when available, otherwise error_log().
		 *
		 * @param string $message Message to record.
		 * @return void
		 */
		private static function log_error( $message ) {
			if ( function_exists( 'wc_get_logger' ) ) {
				$logger = wc_get_logger();

				if ( $logger ) {
					$logger->error( $message, array( 'source' => 'wc-audit-logger' ) );
					return;
				}
			}

			if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
				// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
				error_log( '[wc-audit-logger] ' . $message );
			}
		}
	}

endif;

/**
 * Boot once WooCommerce is loaded; stay silent if it is not installed.
 */
add_action(
	'plugins_loaded',
	static function () {
		if ( class_exists( 'WooCommerce' ) ) {
			WC_Audit_Logger::init();
		}
	},
	20
);

/**
 * Declare HPOS / custom order tables compatibility (this plugin touches neither).
 */
add_action(
	'before_woocommerce_init',
	static function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
				'custom_order_tables',
				__FILE__,
				true
			);
		}
	}
);
