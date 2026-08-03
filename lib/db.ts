import mongoose, { type Mongoose } from 'mongoose';

/**
 * Serverless-safe Mongoose connection.
 *
 * Every Vercel serverless invocation can reuse a warm container, but module
 * scope is re-evaluated whenever the bundle is reloaded (and in dev on every
 * hot reload). Caching the connection *and the in-flight promise* on
 * `globalThis` guarantees:
 *
 *   1. One connection per container instead of one per request, so the Atlas
 *      free tier (500 connections) is never exhausted.
 *   2. Concurrent requests during a cold start share a single `connect()` call
 *      instead of racing and opening N pools.
 */

interface MongooseCache {
  conn: Mongoose | null;
  promise: Promise<Mongoose> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var mongoose: MongooseCache | undefined;
}

const cached: MongooseCache = global.mongoose ?? { conn: null, promise: null };

// Persist across module re-evaluation / hot reloads.
global.mongoose = cached;

export async function dbConnect(): Promise<Mongoose> {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
      throw new Error(
        'MONGODB_URI is not defined. Add it to .env.local (see .env.local.example) ' +
          'or to your Vercel project environment variables.'
      );
    }

    cached.promise = mongoose.connect(uri, {
      // Fail fast instead of buffering queries forever when the pool is down —
      // a hanging serverless function costs money and blocks the WooCommerce site.
      bufferCommands: false,
      // A serverless container handles one request at a time; a small pool is
      // plenty and keeps the Atlas connection count low.
      maxPoolSize: 5,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 8_000,
      socketTimeoutMS: 20_000,
      dbName: process.env.MONGODB_DB || undefined,
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (error) {
    // Reset so the next request retries instead of awaiting a rejected promise.
    cached.promise = null;
    throw error;
  }

  return cached.conn;
}

export default dbConnect;
