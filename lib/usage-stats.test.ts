import { describe, it, expect } from "vitest";
import { parseUsageStats } from "./usage-stats";

const valid = {
  line: "10 completed runs in the last 30 days",
  llms: "## Usage\n- 10 completed runs",
  url: "https://app.letterstory.com/shared/usage/x",
  interaction_statistic: [{ "@type": "InteractionCounter", userInteractionCount: 10 }],
};

describe("parseUsageStats", () => {
  it("reads the line, llms section, url and counters", () => {
    expect(parseUsageStats(valid)).toEqual({
      line: valid.line,
      llms: valid.llms,
      url: valid.url,
      interactionStatistic: valid.interaction_statistic,
    });
  });

  it("returns null when any field is missing or malformed", () => {
    expect(parseUsageStats(null)).toBeNull();
    expect(parseUsageStats({ ...valid, line: "" })).toBeNull();
    expect(parseUsageStats({ ...valid, llms: undefined })).toBeNull();
    expect(parseUsageStats({ ...valid, url: "javascript:alert(1)" })).toBeNull();
    expect(parseUsageStats({ ...valid, interaction_statistic: [] })).toBeNull();
    expect(parseUsageStats({ ...valid, interaction_statistic: ["x"] })).toBeNull();
  });
});
