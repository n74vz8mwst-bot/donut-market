// Run this once after connecting your database for the first time:
//   cd backend
//   node seed.js
// Safe to re-run — it skips any ticker that already exists.

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Company = require("./models/Company");
const PriceHistory = require("./models/PriceHistory");

dotenv.config();

const companies = [
  { ticker: "dnut", name: "Donut Corp", icon: "🍩", sector: "Bakery Tech", price: 250.4, openPrice: 250.4, liquidity: 9000, status: "open" },
  { ticker: "glz", name: "Glaze Dynamics", icon: "🧁", sector: "Consumer", price: 118.75, openPrice: 118.75, liquidity: 4000, status: "open" },
  { ticker: "sprk", name: "Sprinkle Systems", icon: "✨", sector: "Tech", price: 74.2, openPrice: 74.2, liquidity: 2500, status: "open" },
  { ticker: "krsp", name: "Krispy Holdings", icon: "🍪", sector: "Bakery Tech", price: 340.1, openPrice: 340.1, liquidity: 12000, status: "open" },
  { ticker: "jlly", name: "Jelly Filled Inc", icon: "🍮", sector: "Consumer", price: 52.6, openPrice: 52.6, liquidity: 1800, status: "closed" },
  { ticker: "frst", name: "Frosting Freight", icon: "🚚", sector: "Logistics", price: 29.9, openPrice: 29.9, liquidity: 1200, status: "open" },
  { ticker: "chz", name: "Choco Zaibatsu", icon: "🍫", sector: "Conglomerate", price: 501.0, openPrice: 501.0, liquidity: 20000, status: "open" },
  { ticker: "mplg", name: "Maple Glow Co.", icon: "🍁", sector: "Consumer", price: 88.3, openPrice: 88.3, liquidity: 3000, status: "closed" },
];

async function seed() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set — check your .env file.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB.");

  let created = 0;
  for (const c of companies) {
    const existing = await Company.findOne({ ticker: c.ticker });
    if (existing) {
      console.log(`- ${c.ticker} already exists, skipping.`);
      continue;
    }
    await Company.create(c);
    await PriceHistory.create({ companyId: c.ticker, price: c.price });
    created++;
    console.log(`+ created ${c.ticker} (${c.name})`);
  }

  console.log(`Done. ${created} companies created.`);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
