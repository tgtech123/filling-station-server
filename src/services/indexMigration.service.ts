import mongoose from "mongoose";

/**
 * Drop indexes that a schema change has made wrong.
 *
 * Mongoose creates new indexes on boot but never removes obsolete ones, so a
 * field that stops being unique keeps enforcing uniqueness in production
 * forever. The symptom is a duplicate-key error on a value that the code says
 * should be allowed — which reads as a bug in the feature rather than a stale
 * index, and is correspondingly hard to find.
 *
 * Idempotent: an index that is already gone is skipped silently, so this is
 * safe to run on every boot and safe to leave in place after it has done its
 * job. It never touches data.
 */

interface ObsoleteIndex {
  collection: string;
  index: string;
  reason: string;
}

const OBSOLETE: ObsoleteIndex[] = [
  {
    collection: "lubricants",
    index: "barcode_1",
    reason:
      "barcode was globally unique; it is now unique per station (station_barcode_unique). " +
      "Real manufacturer barcodes on drinks and snacks are shared between stations, so the " +
      "global index stopped the second station stocking the same product.",
  },
];

export async function dropObsoleteIndexes(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;

  for (const { collection, index, reason } of OBSOLETE) {
    try {
      const exists = await db.listCollections({ name: collection }).hasNext();
      if (!exists) continue;

      const indexes = await db.collection(collection).indexes();
      if (!indexes.some((i: any) => i.name === index)) continue;

      await db.collection(collection).dropIndex(index);
      console.log(`🧹 Dropped obsolete index ${collection}.${index} — ${reason}`);
    } catch (err: any) {
      // Never fatal. A failure here leaves the old index in place, which is the
      // status quo, and the app must still start.
      console.warn(
        `⚠️  Could not drop obsolete index ${collection}.${index}: ${err?.message}`
      );
    }
  }
}
