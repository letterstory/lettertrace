import { describe, expect, it } from "vitest";
import { normalizeCompetitor, normalizeCompetitorList } from "@/lib/competitors";

describe("normalizeCompetitor", () => {
  it("trims the name and lowercases the domain", () => {
    expect(normalizeCompetitor({ name: "  Asana ", domain: " Asana.COM " })).toEqual({
      name: "Asana",
      aliases: [],
      domain: "asana.com",
    });
  });

  it("accepts aliases as an array or as one comma-separated string", () => {
    expect(normalizeCompetitor({ name: "Monday", aliases: ["monday.com", " Monday "] }).aliases)
      .toEqual(["monday.com", "Monday"]);
    expect(normalizeCompetitor({ name: "Monday", aliases: "monday.com, Monday ,," }).aliases)
      .toEqual(["monday.com", "Monday"]);
  });

  it("treats a blank or missing domain as null", () => {
    expect(normalizeCompetitor({ name: "X", domain: "   " }).domain).toBeNull();
    expect(normalizeCompetitor({ name: "X" }).domain).toBeNull();
  });

  it("survives junk without throwing", () => {
    expect(normalizeCompetitor(null)).toEqual({ name: "", aliases: [], domain: null });
    expect(normalizeCompetitor({ name: 42, aliases: 7, domain: {} })).toEqual({
      name: "",
      aliases: [],
      domain: null,
    });
  });
});

describe("normalizeCompetitorList", () => {
  it("drops unnamed rows instead of rejecting the batch", () => {
    const list = normalizeCompetitorList([
      { name: "Asana" },
      { name: "   " },
      { name: "Notion" },
    ]);
    expect(list.map((c) => c.name)).toEqual(["Asana", "Notion"]);
  });

  // Both would abort the insert: `competitors` is unique on (project_id, name).
  it("collapses case-insensitive repeats, keeping the first", () => {
    const list = normalizeCompetitorList([
      { name: "Asana", domain: "asana.com" },
      { name: "asana", domain: "other.com" },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].domain).toBe("asana.com");
  });

  it("excludes the brand and its aliases, case-insensitively", () => {
    const list = normalizeCompetitorList(
      [{ name: "Acme" }, { name: "acme corp" }, { name: "Asana" }],
      { exclude: ["Acme", "Acme Corp"] },
    );
    expect(list.map((c) => c.name)).toEqual(["Asana"]);
  });

  it("ignores blank entries in the exclude list", () => {
    const list = normalizeCompetitorList([{ name: "Asana" }], { exclude: ["", "  "] });
    expect(list.map((c) => c.name)).toEqual(["Asana"]);
  });

  it("caps the list when a limit is given", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `Rival ${i}` }));
    expect(normalizeCompetitorList(many, { limit: 5 })).toHaveLength(5);
    expect(normalizeCompetitorList(many)).toHaveLength(9);
  });

  it("returns an empty list for anything that isn't an array", () => {
    for (const junk of [null, undefined, "Asana", 3, { name: "Asana" }]) {
      expect(normalizeCompetitorList(junk)).toEqual([]);
    }
  });
});
