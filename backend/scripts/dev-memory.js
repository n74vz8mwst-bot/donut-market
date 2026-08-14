/* ===========================================================================
   Donut Market with no setup at all:

       npm run dev:memory

   Boots a real MongoDB in a temporary directory (as a single-node replica set,
   so trades still run in proper transactions), seeds the exchange and an admin
   account, and starts the normal server against it. Nothing is written to your
   machine outside the temp folder, and everything disappears when you stop it.

   Use this to try the simulator, develop against it, or run the test suite.
   For anything you want to keep, point MONGODB_URI at MongoDB Atlas instead —
   see SETUP.md.
   =========================================================================== */

const path = require("path");
const crypto = require("crypto");

async function main() {
  let MongoMemoryReplSet;
  try {
    ({ MongoMemoryReplSet } = require("mongodb-memory-server"));
  } catch (_err) {
    console.error(
      "mongodb-memory-server isn't installed.\n" + "Run `npm install` inside backend/ and try again."
    );
    process.exit(1);
  }

  console.log("⏳ Starting a temporary MongoDB (first run downloads it, ~90MB)…");
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });

  // getUri() takes the database name — string-concatenating it would land
  // inside the ?replicaSet= query string instead.
  process.env.MONGODB_URI = replSet.getUri("donutmarket");
  process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
  process.env.PORT = process.env.PORT || "3000";

  console.log("✅ Temporary database ready.");

  // Seed with the same code path `npm run seed` uses.
  const mongoose = require("mongoose");
  const { seedCompanies, seedAdmin } = require(path.join(__dirname, "..", "seed.js"));
  await mongoose.connect(process.env.MONGODB_URI);
  await seedCompanies();
  const admin = await seedAdmin();
  await mongoose.disconnect();

  const { start } = require(path.join(__dirname, "..", "server.js"));
  await start();

  console.log("\n────────────────────────────────────────────────");
  console.log("🍩  Donut Market is live at http://localhost:" + process.env.PORT);
  if (admin) {
    console.log(`🔑  Admin login: ${admin.email} / ${process.env.SEED_ADMIN_PASSWORD || "donutdonut"}`);
  }
  console.log("💾  This database is temporary — everything resets on exit.");
  console.log("────────────────────────────────────────────────\n");

  const shutdown = async () => {
    await replSet.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
