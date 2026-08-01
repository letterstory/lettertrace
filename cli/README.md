# lettertrace

Command-line client for a [Lettertrace](https://github.com/letterstory/lettertrace) deployment: monitor how your brand shows up in AI assistant answers.

Sign-in is OAuth 2.1 only (no API keys): the first command that needs access opens your browser to approve a scoped, expiring token, stored under `~/.lettertrace/config.json` and refreshed automatically. Data commands use the REST v1 API; the `mcp` commands speak the Model Context Protocol directly to `/api/mcp`, exactly as an AI assistant would.

## Install

```bash
npm install -g lettertrace
```

Or run it without installing:

```bash
npx lettertrace help
```

Also published under the `@letterstory` org scope as `@letterstory/lettertrace` (same package). Both install a `lettertrace` command on your `PATH`.

Requires Node.js 20 or newer.

## Quick start

```bash
lettertrace login --url https://your-app.com   # browser sign-in / create account
lettertrace whoami --json                       # machine-readable auth status

# Bring your own provider key (verified on save, encrypted at rest)
lettertrace keys set anthropic                   # hidden prompt

# Build a project and start measuring
lettertrace projects create --name "Acme" --brand "Acme" --domains acme.io
lettertrace prompts add <project> --text "best crm for startups" --topic CRM
lettertrace competitors add <project> Vanta Drata Secureframe
lettertrace runs trigger <project>
lettertrace runs get <runId>                     # share-of-voice report (--json for full)

# Talk to the MCP endpoint directly
lettertrace mcp tools
lettertrace mcp call get_share_of_voice_report --project_id <project>
```

Every command accepts `--json` for machine-readable output and `--url <base>` to target a deployment.

## Base URL

Resolved in order: `--url`, then `$LETTERTRACE_URL`, then the URL saved at login, then the hosted default `https://lettertrace.com`.

## Commands

Run `lettertrace help` for the full list. Highlights:

- **Auth** — `login`, `logout`, `whoami`
- **Provider keys (BYOK)** — `keys`, `keys set <provider>`, `keys remove <provider>`
- **Router keys** — `routers`, `routers set <router>`, `routers remove <router>`
- **Data** — `projects`, `prompts`, `competitors`, `runs`, `history`, `logs`
- **MCP** — `mcp tools`, `mcp call <tool>`

## License

MIT
