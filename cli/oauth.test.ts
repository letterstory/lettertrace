import { describe, expect, it } from "vitest";
import { browserLaunch as browserLaunchRaw } from "./oauth.mjs";

type Launch = { cmd: string; args: string[] };
const browserLaunch = browserLaunchRaw as (url: string, platform?: string) => Launch;

// The authorize URL the CLI opens: many "&"-joined parameters and percent
// escapes — everything cmd.exe mangles.
const URL_ =
  "https://lettertrace.com/api/oauth/authorize?response_type=code&client_id=lt_cli" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback&scope=projects%3Aread+runs%3Aread" +
  "&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&resource=v1";

describe("browserLaunch", () => {
  it("never routes a Windows launch through cmd.exe (#115)", () => {
    const { cmd, args } = browserLaunch(URL_, "win32");
    expect(cmd.toLowerCase()).toMatch(/powershell\.exe$/);
    expect(cmd.toLowerCase()).not.toContain("cmd");
    expect(args).not.toContain("start");
    // The URL itself must not appear as a bare argv entry a shell could split.
    expect(args).not.toContain(URL_);
  });

  it("hands PowerShell the whole URL, intact, as a literal string", () => {
    const { args } = browserLaunch(URL_, "win32");
    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toBe(`Start-Process '${URL_}'`);
    // Every parameter survives, including the ones after the first "&".
    for (const key of ["client_id=lt_cli", "redirect_uri=", "code_challenge=", "resource=v1"]) {
      expect(script).toContain(key);
    }
  });

  it("escapes a single quote so the PowerShell string cannot be terminated early", () => {
    const { args } = browserLaunch("https://x.test/?q=it's", "win32");
    const script = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
    expect(script).toBe("Start-Process 'https://x.test/?q=it''s'");
  });

  it("uses the platform opener directly on macOS and Linux", () => {
    expect(browserLaunch(URL_, "darwin")).toEqual({ cmd: "open", args: [URL_] });
    expect(browserLaunch(URL_, "linux")).toEqual({ cmd: "xdg-open", args: [URL_] });
  });
});
