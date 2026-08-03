<?php
/**
 * Plugin Name:       WC Audit Logger Bridge
 * Plugin URI:        https://github.com/jurian360/woocommerce-logger
 * Description:       Sends product price, stock, status and catalog-visibility changes made by administrators to an external Next.js audit-log endpoint.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * WC requires at least: 7.0
 * WC tested up to:   9.4
 * Author:            jurian360
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       wc-audit-logger
 *
 * ---------------------------------------------------------------------------
 * CONFIGURATION — add to wp-config.php (above the "That's all" line):
 *
 *     define( 'WC_AUDIT_LOGGER_ENDPOINT', 'https://your-app.vercel.app/api/logs/product-change' );
 *     define( 'WC_AUDIT_LOGGER_SECRET',   'the same value as API_SECRET in Vercel' );
 *
 * Both fall back to the `wc_audit_logger_endpoint` / `wc_audit_logger_secret`
 * options, and can be overridden with the filters of the same name.
 *
 * Installation: drop this file in wp-content/plugins/wc-audit-logger/ and
 * activate it, or place it in a must-use plugin directory (wp-content/mu-plugins/).
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

		const VERSION = '1.0.0';

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

			// Variations use their own object type in WC_Data::save().
			add_action( 'woocommerce_before_product_variation_object_save', array( __CLASS__, 'capture' ), 10, 1 );
			add_action( 'woocommerce_after_product_variation_object_save', array( __CLASS__, 'dispatch' ), 10, 1 );

			add_action( 'admin_notices', array( __CLASS__, 'maybe_render_config_notice' ) );
		}

		/**
		 * Snapshot the diff before WooCommerce applies (and discards) the changes.
		 *
		 * @param WC_Product $product Product being saved.
		 * @return void
		 */
		public static function capture( $product ) {
			if ( ! $product instanceof WC_Product || ! self::should_log() ) {
				return;
			}

			$changes = $product->get_changes();

			if ( empty( $changes ) ) {
				return;
			}

			// `get_data()` returns the persisted values; `get_changes()` the new ones.
			$old = $product->get_data();
			$diff = self::build_diff( $old, $changes );

			if ( empty( $diff ) ) {
				return;
			}

			// Ignore the auto-draft rows WordPress creates when you click "Add product".
			$new_status = isset( $changes['status'] ) ? $changes['status'] : $product->get_status( 'edit' );
			if ( 'auto-draft' === $new_status ) {
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
				return;
			}

			$user = wp_get_current_user();

			$payload = array(
				'product_id' => (int) $product_id,
				'parent_id'  => (int) $product->get_parent_id(),
				'sku'        => (string) $product->get_sku(),
				'name'       => (string) $product->get_name(),
				'currency'   => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : '',
				'site'       => home_url(),
				'source'     => self::request_source(),
				'permalink'  => (string) $product->get_permalink(),
				'edit_link'  => admin_url( 'post.php?post=' . $product_id . '&action=edit' ),
				'is_new'     => (bool) $captured['is_new'],
				'admin'      => array(
					'id'    => (int) $user->ID,
					'user'  => (string) $user->user_login,
					'email' => (string) $user->user_email,
					'roles' => array_values( (array) $user->roles ),
				),
				'timestamp'  => gmdate( 'c' ),
				'changes'    => $captured['changes'],
			);

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
		 * Whether the current request should be logged.
		 *
		 * Only interactive changes by a user who can edit products are recorded —
		 * CRON, WP-CLI, imports and unauthenticated requests are ignored.
		 *
		 * @return bool
		 */
		private static function should_log() {
			if ( defined( 'WP_CLI' ) && WP_CLI ) {
				return false;
			}

			if ( function_exists( 'wp_doing_cron' ) ? wp_doing_cron() : ( defined( 'DOING_CRON' ) && DOING_CRON ) ) {
				return false;
			}

			if ( defined( 'WP_IMPORTING' ) && WP_IMPORTING ) {
				return false;
			}

			if ( ! function_exists( 'is_user_logged_in' ) || ! is_user_logged_in() ) {
				return false;
			}

			if ( ! current_user_can( 'edit_products' ) ) {
				return false;
			}

			if ( '' === self::get_endpoint() || '' === self::get_secret() ) {
				return false;
			}

			/**
			 * Final say on whether this request is logged.
			 *
			 * @param bool $should_log Current decision.
			 */
			return (bool) apply_filters( 'wc_audit_logger_should_log', true );
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

		/**
		 * POST the payload without making the shop wait for a response.
		 *
		 * @param array<string, mixed> $payload Payload to send.
		 * @return void
		 */
		private static function send( array $payload ) {
			$endpoint = self::get_endpoint();
			$secret   = self::get_secret();

			if ( '' === $endpoint || '' === $secret ) {
				return;
			}

			$body = wp_json_encode( $payload );

			if ( false === $body ) {
				self::log_error( 'Could not JSON-encode the audit payload.' );
				return;
			}

			$response = wp_remote_post(
				$endpoint,
				array(
					'method'      => 'POST',
					// Fire-and-forget: the admin screen never blocks on the audit API.
					'blocking'    => false,
					'timeout'     => 2,
					'redirection' => 0,
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

			// With 'blocking' => false only transport-level failures surface here.
			if ( is_wp_error( $response ) ) {
				self::log_error( 'Request failed: ' . $response->get_error_message() );
			}
		}

		/**
		 * Endpoint URL.
		 *
		 * @return string
		 */
		private static function get_endpoint() {
			$endpoint = defined( 'WC_AUDIT_LOGGER_ENDPOINT' )
				? WC_AUDIT_LOGGER_ENDPOINT
				: get_option( 'wc_audit_logger_endpoint', '' );

			/** @param string $endpoint Audit API endpoint. */
			$endpoint = (string) apply_filters( 'wc_audit_logger_endpoint', $endpoint );

			return esc_url_raw( trim( $endpoint ) );
		}

		/**
		 * Shared secret.
		 *
		 * @return string
		 */
		private static function get_secret() {
			$secret = defined( 'WC_AUDIT_LOGGER_SECRET' )
				? WC_AUDIT_LOGGER_SECRET
				: get_option( 'wc_audit_logger_secret', '' );

			/** @param string $secret Shared secret for the X-Api-Secret header. */
			return trim( (string) apply_filters( 'wc_audit_logger_secret', $secret ) );
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

		/**
		 * Write to the WooCommerce logger when available, otherwise error_log().
		 *
		 * @param string $message Message to record.
		 * @return void
		 */
		private static function log_error( $message ) {
			if ( function_exists( 'wc_get_logger' ) ) {
				wc_get_logger()->error( $message, array( 'source' => 'wc-audit-logger' ) );
				return;
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
