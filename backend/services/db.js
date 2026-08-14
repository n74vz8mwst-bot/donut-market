const mongoose = require("mongoose");

/* ===========================================================================
   Transaction helper.

   Order placement moves money, shares and the price at once — it has to be all
   or nothing. MongoDB gives us that with transactions, but only on a replica
   set or a sharded cluster. Atlas (and the in-memory dev server, see
   scripts/dev-memory.js) provide one; a bare local `mongod` does not.

   Rather than crash on a standalone server, we probe the topology once at
   startup and fall back to running the same callback without a session. The
   fallback is a real trade-off — a crash mid-order could leave a partially
   applied trade — so we say so loudly in the log instead of hiding it.
   =========================================================================== */

let transactionsSupported = null;

async function detectTransactionSupport() {
  try {
    const admin = mongoose.connection.db.admin();
    const info = await admin.command({ hello: 1 });
    transactionsSupported = Boolean(info.setName || info.msg === "isdbgrid");
  } catch (_err) {
    transactionsSupported = false;
  }
  if (!transactionsSupported) {
    console.warn(
      "⚠️  This MongoDB deployment has no replica set, so trades cannot run in a transaction.\n" +
        "   Donut Market will still work, but a crash mid-order could leave it half-applied.\n" +
        "   MongoDB Atlas and `npm run dev:memory` both give you transactions for free."
    );
  }
  return transactionsSupported;
}

function supportsTransactions() {
  return transactionsSupported === true;
}

// Runs `fn(session)` inside a transaction when the deployment supports one,
// and plainly (session === null) when it doesn't.
async function withTransaction(fn) {
  if (!supportsTransactions()) return fn(null);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    session.endSession();
  }
}

// Mongoose wants `{ session }` or nothing at all — never `{ session: null }`.
const sessionOpts = (session) => (session ? { session } : {});

module.exports = { detectTransactionSupport, supportsTransactions, withTransaction, sessionOpts };
