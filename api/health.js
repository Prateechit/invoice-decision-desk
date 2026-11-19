// Vercel serverless function: GET /api/health (tells the page which AI reader is configured)
const { handleHealth } = require("../lib/ai.js");

module.exports = (req, res) => {
  const out = handleHealth();
  res.status(out.status).json(out.json);
};
