// Vercel serverless function: POST /api/extract
const { handleExtract } = require("../lib/ai.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const out = await handleExtract(req.body, ip);
  res.status(out.status).json(out.json);
};

module.exports.config = { maxDuration: 60 };
