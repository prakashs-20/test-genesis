import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Update production baselines after a verified deploy.
 * Run this AFTER production deploy succeeds and is verified stable.
 */

const baselinesPath = resolve("tests/eval/baselines.json");
const comparisonPath = "eval-comparison.json";

try {
  if (!existsSync(comparisonPath)) {
    console.error(
      "No eval comparison results found. Run compare-baselines.js first.",
    );
    process.exit(1);
  }

  const comparison = JSON.parse(readFileSync(comparisonPath, "utf-8"));
  const baselines = JSON.parse(readFileSync(baselinesPath, "utf-8"));

  let updated = 0;
  for (const agent of comparison.agents) {
    if (!baselines.agents[agent.agentId]) {
      baselines.agents[agent.agentId] = {};
    }

    for (const skill of agent.skills) {
      if (
        skill.current >=
        (baselines.agents[agent.agentId][skill.skillId]?.accuracy || 0)
      ) {
        baselines.agents[agent.agentId][skill.skillId] = {
          accuracy: skill.current,
          updatedAt: new Date().toISOString(),
        };
        updated++;
        console.log(
          `  Updated: ${agent.agentId}/${skill.skillId} -> ${skill.current}`,
        );
      }
    }
  }

  baselines.lastUpdated = new Date().toISOString();
  writeFileSync(baselinesPath, JSON.stringify(baselines, null, 2));

  console.log(`\nBaselines updated: ${updated} skills improved or maintained.`);
} catch (err) {
  console.error("Failed to update baselines:", err.message);
  process.exit(1);
}
