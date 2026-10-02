import { describe, expect, it } from "vitest";
import { orgButtonHost } from "./org-switcher";

describe("orgButtonHost", () => {
  // The closed button used to print the workspace name under the brand. Those
  // two strings match whenever onboarding copied the brand into the name, so
  // the sidebar repeated itself. The second line is the primary domain.
  it("shows a pasted URL as a bare host", () => {
    expect(orgButtonHost("https://www.WSJ.com/path")).toBe("wsj.com");
  });

  it("leaves a bare host alone", () => {
    expect(orgButtonHost("wsj.com")).toBe("wsj.com");
  });

  // No domain means no second line. Falling back to the workspace name would
  // put the repetition back on the orgs that have nothing else to show.
  it("omits the line when there is no domain", () => {
    expect(orgButtonHost("")).toBeNull();
    expect(orgButtonHost(null)).toBeNull();
    expect(orgButtonHost(undefined)).toBeNull();
    expect(orgButtonHost("   ")).toBeNull();
  });
});
