import { afterEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => [] as (() => void)[]);
vi.mock("react", () => ({
  useEffect: (effect: () => void) => effects.push(effect),
}));
import { LetterVisitDashboard } from "./lettervisit-dashboard";

afterEach(() => {
  effects.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Letter on signed-in pages", () => {
  it("loads the Data panel without enabling identification or A/B tests", () => {
    vi.stubEnv("NEXT_PUBLIC_LETTERVISIT_KEY", "lv_pub_test");
    const attributes: Record<string, string> = {};
    const tag = {
      id: "",
      src: "",
      async: false,
      setAttribute: (key: string, value: string) => {
        attributes[key] = value;
      },
    };
    const appendChild = vi.fn();
    const browser = {
      lettervisit: undefined as undefined | { q: unknown[][] },
    };
    vi.stubGlobal("window", browser);
    vi.stubGlobal("document", {
      getElementById: () => null,
      createElement: () => tag,
      head: { appendChild },
    });
    LetterVisitDashboard({ email: "member@example.com" });
    effects[0]();
    expect(appendChild).toHaveBeenCalledWith(tag);
    expect(attributes).toMatchObject({
      "data-key": "lv_pub_test",
      "data-editor": "data",
      "data-identification": "off",
      "data-variationals": "off",
    });
    expect(browser.lettervisit?.q).toEqual([
      ["consent", "denied"],
      ["identify", "member@example.com"],
    ]);
  });
  it("keeps self-hosted installs without a site key untouched", () => {
    vi.stubEnv("NEXT_PUBLIC_LETTERVISIT_KEY", "");
    LetterVisitDashboard({ email: null });
    expect(() => effects[0]()).not.toThrow();
  });
});
