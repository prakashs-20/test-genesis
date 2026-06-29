import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Compare agent eval results against production baselines.
 * Fails if any agent's accuracy drops > 5%.
 * Warns if any agent's accuracy drops > 2%.
 */

const REGRESSION_THRESHOLD = 5; // Percent drop that blocks production
const WARNING_THRESHOLD = 2; // Percent drop that triggers a warning

const baselinesPath = resolve("tests/eval/baselines.json");
const evalResultsDir = resolve("eval-results");

try {
  const baselines = JSON.parse(readFileSync(baselinesPath, "utf-8"));
  const results = {
    agents: [],
    hasRegression: false,
    hasWarning: false,
    timestamp: new Date().toISOString(),
  };

  for (const [agentId, skills] of Object.entries(baselines.agents || {})) {
    const agentResult = {
      agentId,
      skills: [],
      regression: false,
      warning: false,
    };

    for (const [skillId, baseline] of Object.entries(skills)) {
      const evalPath = resolve(evalResultsDir, `${agentId}/${skillId}.json`);
      let evalAccuracy;

      try {
        const evalData = JSON.parse(readFileSync(evalPath, "utf-8"));
        evalAccuracy = evalData.accuracy;
      } catch {
        console.warn(`  No eval results for ${agentId}/${skillId}, skipping`);
        continue;
      }

      const drop = baseline.accuracy - evalAccuracy;
      const dropPct = (drop / baseline.accuracy) * 100;

      const skillResult = {
        skillId,
        baseline: baseline.accuracy,
        current: evalAccuracy,
        dropPct: Math.round(dropPct * 100) / 100,
        status:
          dropPct > REGRESSION_THRESHOLD
            ? "REGRESSION"
            : dropPct > WARNING_THRESHOLD
              ? "WARNING"
              : "OK",
      };

      if (skillResult.status === "REGRESSION") {
        agentResult.regression = true;
        results.hasRegression = true;
      }
      if (skillResult.status === "WARNING") {
        agentResult.warning = true;
        results.hasWarning = true;
      }

      agentResult.skills.push(skillResult);
      console.log(
        `  ${agentId}/${skillId}: ${baseline.accuracy} -> ${evalAccuracy} (${skillResult.status})`,
      );
    }

    results.agents.push(agentResult);
  }

  writeFileSync("eval-comparison.json", JSON.stringify(results, null, 2));

  if (results.hasRegression) {
    console.error(
      "\nREGRESSION DETECTED: Agent accuracy dropped > 5%. Production deploy blocked.",
    );
    process.exit(1);
  }
  if (results.hasWarning) {
    console.warn(
      "\nWARNING: Agent accuracy dropped > 2%. Review before production deploy.",
    );
  }

  console.log("\nAll agent baselines within acceptable range.");
} catch (err) {
  console.error("Failed to compare baselines:", err.message);
  process.exit(1);
}
