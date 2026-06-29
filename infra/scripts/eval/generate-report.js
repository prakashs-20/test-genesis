import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * Generate a consolidated eval report from comparison results.
 * Output: eval-report.json (consumed by CI pipeline for production gating).
 */

try {
  const comparisonPath = "eval-comparison.json";
  if (!existsSync(comparisonPath)) {
    console.log("No comparison results found. Generating empty report.");
    writeFileSync(
      "eval-report.json",
      JSON.stringify(
        {
          hasRegression: false,
          agents: [],
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const comparison = JSON.parse(readFileSync(comparisonPath, "utf-8"));

  const report = {
    hasRegression: comparison.hasRegression,
    hasWarning: comparison.hasWarning,
    timestamp: comparison.timestamp,
    summary: {
      totalAgents: comparison.agents.length,
      regressions: comparison.agents.filter((a) => a.regression).length,
      warnings: comparison.agents.filter((a) => a.warning).length,
      passing: comparison.agents.filter((a) => !a.regression && !a.warning)
        .length,
    },
    agents: comparison.agents.map((agent) => ({
      agentId: agent.agentId,
      status: agent.regression
        ? "REGRESSION"
        : agent.warning
          ? "WARNING"
          : "OK",
      skills: agent.skills.map((s) => ({
        skillId: s.skillId,
        baseline: s.baseline,
        current: s.current,
        dropPct: s.dropPct,
        status: s.status,
      })),
    })),
  };

  writeFileSync("eval-report.json", JSON.stringify(report, null, 2));

  console.log("Eval report generated: eval-report.json");
  console.log(`  Total agents: ${report.summary.totalAgents}`);
  console.log(`  Regressions: ${report.summary.regressions}`);
  console.log(`  Warnings: ${report.summary.warnings}`);
  console.log(`  Passing: ${report.summary.passing}`);
  console.log(
    `  Production gate: ${report.hasRegression ? "BLOCKED" : "OPEN"}`,
  );
} catch (err) {
  console.error("Failed to generate eval report:", err.message);
  process.exit(1);
}
