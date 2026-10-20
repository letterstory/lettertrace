import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrialEndedEntry } from "./trial-ended-modal";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Next injects the JSX runtime for app components; Vitest's node transform
// does not, so provide the same global before importing the component.
Object.assign(globalThis, { React });
const { TrialEndedDialog, trialEndedRequests } = await import("./trial-ended-modal");

function openingTag(html: string, controls: string): string {
  const marker = `aria-controls="${controls}"`;
  const at = html.indexOf(marker);
  return html.slice(Math.max(0, at - 180), at + marker.length);
}

describe("TrialEndedDialog", () => {
  it("opens Claude's help and leaves the other two closed", () => {
    const html = renderToStaticMarkup(
      React.createElement(TrialEndedDialog, {
        used: 15,
        limit: 15,
        onDismiss: () => {},
        onSaved: () => {},
      }),
    );

    expect(openingTag(html, "trial-ended-help-anthropic")).toContain('aria-expanded="true"');
    expect(openingTag(html, "trial-ended-help-openai")).toContain('aria-expanded="false"');
    expect(openingTag(html, "trial-ended-help-openrouter")).toContain('aria-expanded="false"');

    // The panel is the one that is open, so only Claude's steps are in the
    // markup. A second open panel would mean the accordion failed closed.
    expect(html).toContain("Claude Pro or Max subscription");
    expect(html).not.toContain("ChatGPT Plus or Pro subscription");

    expect(html).toContain('type="password"');
    // renderToStaticMarkup keeps React's camelCase here. In the document the
    // attribute is autocomplete, and HTML treats the two as the same name.
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('spellcheck="false"');
    expect(html).toContain("sk-ant-");
    expect(html).toContain("sk-proj-");
    expect(html).toContain("sk-or-v1-");

    expect(html).toContain("https://platform.claude.com/settings/keys");
    expect(html).toContain("https://platform.openai.com/api-keys");
    expect(html).toContain("https://openrouter.ai/settings/keys");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });
});

describe("trialEndedRequests", () => {
  const blank = (entry: TrialEndedEntry, apiKey: string): TrialEndedEntry =>
    ({ ...entry, apiKey }) as TrialEndedEntry;

  it("sends each filled field to the route that stores that kind of key", () => {
    const requests = trialEndedRequests([
      blank({ id: "anthropic", kind: "provider", provider: "anthropic", apiKey: "" }, "  sk-ant-x  "),
      blank({ id: "openai", kind: "provider", provider: "openai", apiKey: "" }, "   "),
      blank({ id: "openrouter", kind: "router", router: "openrouter", apiKey: "" }, "sk-or-v1-x"),
      blank({ id: "merge", kind: "router", router: "merge", apiKey: "" }, ""),
    ]);

    expect(requests).toEqual([
      { id: "anthropic", url: "/api/keys", body: { provider: "anthropic", apiKey: "sk-ant-x" } },
      {
        id: "openrouter",
        url: "/api/router-keys",
        body: { router: "openrouter", apiKey: "sk-or-v1-x" },
      },
    ]);
  });

  it("makes no request when every field is empty", () => {
    expect(
      trialEndedRequests([
        blank({ id: "anthropic", kind: "provider", provider: "anthropic", apiKey: "" }, "  "),
        blank({ id: "concentrate", kind: "router", router: "concentrate", apiKey: "" }, ""),
      ]),
    ).toEqual([]);
  });
});
