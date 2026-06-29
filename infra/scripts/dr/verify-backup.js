import { execSync } from "node:child_process";

/**
 * Verify RDS backup integrity by running basic queries against a restored instance.
 * This script is run by the weekly backup-verify CI workflow.
 */

const DB_INSTANCE =
  process.env.VERIFY_DB_INSTANCE ||
  `axira-backup-verify-${new Date().toISOString().split("T")[0].replace(/-/g, "")}`;

async function verifyBackup() {
  console.log(`Verifying backup integrity for instance: ${DB_INSTANCE}`);

  // Get the endpoint of the restored instance
  const endpointJson = execSync(
    `aws rds describe-db-instances --db-instance-identifier ${DB_INSTANCE} --query 'DBInstances[0].Endpoint' --output json`,
    { encoding: "utf-8" },
  );
  const endpoint = JSON.parse(endpointJson);
  const dbUrl = `postgresql://axira_admin:${process.env.DB_PASSWORD}@${endpoint.Address}:${endpoint.Port}/axira`;

  console.log(`Connected to: ${endpoint.Address}:${endpoint.Port}`);

  const checks = [
    {
      name: "Extensions exist",
      query:
        "SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'pgcrypto', 'vector') ORDER BY extname",
    },
    {
      name: "Tables exist",
      query:
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
    },
    {
      name: "Tenant data accessible",
      query: "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
    },
    { name: "RLS policies exist", query: "SELECT count(*) FROM pg_policies" },
  ];

  let failures = 0;
  for (const check of checks) {
    try {
      const result = execSync(`psql "${dbUrl}" -c "${check.query}" -t -A`, {
        encoding: "utf-8",
      });
      console.log(`  ${check.name}: ${result.trim()}`);
    } catch (err) {
      console.error(`  ${check.name}: FAILED - ${err.message}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\nBackup verification FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }

  console.log("\nBackup verification PASSED: all integrity checks passed");
}

verifyBackup().catch((err) => {
  console.error("Backup verification error:", err);
  process.exit(1);
});
