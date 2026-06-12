/* Read-only smoke test: signs a JWT for an existing staff member and calls
   the new accounting GET endpoints. No writes are performed. */
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const BASE = `http://localhost:${process.env.SMOKE_PORT || 5057}`;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.db.collection("staffs");
  const accountant = await col.findOne({ role: "accountant" });
  const manager = await col.findOne({ role: "manager" });
  const staff = accountant || manager;
  if (!staff) {
    console.log("NO_STAFF_FOUND");
    process.exit(1);
  }

  const signFor = (s) =>
    jwt.sign(
      { id: String(s._id), role: s.role, station: String(s.station), email: s.email },
      process.env.JWT_SECRET,
      { expiresIn: "10m" }
    );

  console.log(`Testing as ${staff.role} (station ${staff.station})`);
  const headers = { Authorization: `Bearer ${signFor(staff)}` };

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
  // Role gate check: a manager must get the overview (200) but be denied (403)
  // on every working accounting endpoint.
  let gateFail = 0;
  if (manager) {
    const mgrHeaders = { Authorization: `Bearer ${signFor(manager)}` };
    const probe = async (ep, expect) => {
      let code;
      try {
        code = (await axios.get(BASE + ep, { headers: mgrHeaders, timeout: 30000 })).status;
      } catch (e) {
        code = e.response?.status ?? "ERR";
      }
      const ok = code === expect;
      if (!ok) gateFail++;
      console.log(`${ok ? "PASS" : "FAIL"} [manager → ${code}, expected ${expect}] ${ep}`);
    };
    console.log("\nManager role-gate checks:");
    await probe("/api/accounting/reports/dashboard", 200);
    await probe("/api/accounting/accounts", 403);
    await probe("/api/accounting/journals", 403);
    await probe("/api/accounting/ap/invoices", 403);
    await probe("/api/accounting/reports/trial-balance", 403);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${gateFail} gate failures`);
  await mongoose.disconnect();
  process.exit(fail || gateFail ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE_ERROR:", e.message);
  process.exit(1);
});
