const express = require("express");
const Company = require("../models/Company");

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const companies = await Company.find().sort({ name: 1 });
    res.json(companies.map((c) => c.toJSON()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load companies." });
  }
});

router.get("/:ticker", async (req, res) => {
  try {
    const company = await Company.findOne({ ticker: req.params.ticker.toLowerCase() });
    if (!company) return res.status(404).json({ error: "Company not found." });
    res.json(company.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load company." });
  }
});

module.exports = router;
