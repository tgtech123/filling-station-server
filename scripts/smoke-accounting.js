/* Read-only smoke test: signs a JWT for an existing staff member and calls
   the new accounting GET endpoints. No writes are performed. */
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const BASE = `http://localhost:${process.env.SMOKE_PORT || 5057}`;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const staff = await mongoose.connection.db
    .collection("staffs")
    .findOne({ role: { $in: ["accountant", "manager"] } });
  if (!staff) {
    console.log("NO_STAFF_FOUND");
    process.exit(1);
  }

  const token = jwt.sign(
    {
      id: String(staff._id),
      role: staff.role,
      station: String(staff.station),
      email: staff.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );

  console.log(`Testing as ${staff.role} (station ${staff.station})`);
  const headers = { Authorization: `Bearer ${token}` };

  const endpoints = [
    "/api/accounting/accounts",
    "/api/accounting/journals",
    "/api/accounting/ap/invoices",
    "/api/accounting/ap/batches",
    "/api/accounting/ap/open-pos",
    "/api/accounting/ar/customers",
    "/api/accounting/ar/invoices",
    "/api/accounting/ar/credit-notes",
    "/api/accounting/ar/receipts",
    "/api/accounting/bank/statements",
    "/api/accounting/bank/rules",
    "/api/accounting/fx/rates",
    "/api/accounting/fx/revaluations",
    "/api/accounting/depreciation/runs",
    "/api/accounting/audit",
    "/api/accounting/reports/trial-balance",
    "/api/accounting/reports/balance-sheet",
    "/api/accounting/reports/income-statement",
    "/api/accounting/reports/cash-flow",
    "/api/accounting/reports/aging",
    "/api/accounting/reports/dashboard",
    "/api/fixed-assets",
  ];

  let pass = 0, fail = 0;
  for (const ep of endpoints) {
    try {
      const r = await axios.get(BASE + ep, { headers, timeout: 30000 });
      console.log(`PASS [${r.status}] ${ep}`);
      pass++;
    } catch (e) {
      const code = e.response?.status ?? "ERR";
      const msg = e.response?.data?.message || e.message;
      console.log(`FAIL [${code}] ${ep} — ${msg}`);
      fail++;
    }
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE_ERROR:", e.message);
  process.exit(1);
});
