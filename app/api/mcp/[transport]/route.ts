import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { allowsAudience, authenticateApiKey, type Scope } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getProjects } from "@/lib/data";
import {
  getRunReport,
  latestCompletedRun,
  listRuns,
  projectSummary,
  triggerRunForProject,
} from "@/lib/api-service";
import { humanError } from "@/lib/llm";

// MCP server for Lettertrace (Streamable HTTP, stateless — no Redis needed
// since SSE is disabled). Connect with:
//   claude mcp add --transport http lettertrace https://<host>/api/mcp/mcp \
//     -H "Authorization: Bearer lt_live_..."
// or with an OAuth access token (aud=mcp) obtained via the OAuth flow.
// Tools are read/trigger only: Lettertrace reports how a brand shows up in AI
// answers; it deliberately offers no recommendations.

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** The authenticated user's id, stashed in AuthInfo.extra by verifyToken. */
function userIdOf(extra: { authInfo?: AuthInfo }): string {
  const userId = extra.authInfo?.extra?.userId;
  if (typeof userId !== "string") throw new Error("Unauthorized");
  return userId;
}

/** Scopes granted to the current caller, forwarded from verifyToken. A classic
 *  API key carries the full set; an OAuth token carries only what was consented. */
function scopesOf(extra: { authInfo?: AuthInfo }): string[] {
  const s = extra.authInfo?.extra?.scopes;
  return Array.isArray(s) ? (s as string[]) : [];
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

/** Enforce a scope inside a tool, mirroring the REST guard. Returns a tool
 *  error to short-circuit the callback, or null when the scope is held. */
function requireScope(
  extra: { authInfo?: AuthInfo },
  scope: Scope,
): ReturnType<typeof toolError> | null {
  return scopesOf(extra).includes(scope)
    ? null
    : toolError(`This token is missing the required "${scope}" scope.`);
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "list_projects",
      "List the organizations (projects) this Lettertrace account monitors, including brand name, domain, and when each last ran.",
      {},
      async (_args, extra) => {
        const denied = requireScope(extra, "projects:read");
        if (denied) return denied;
        const supabase = createServiceClient();
        const projects = await getProjects(supabase, userIdOf(extra));
        return json({ projects: projects.map(projectSummary) });
      },
    );

    server.tool(
      "list_runs",
      "List recent monitoring runs for a project (status, model, prompt counts, timestamps). Use a run id with get_share_of_voice_report for the metrics.",
      {
        project_id: z.string().uuid().describe("Project id from list_projects"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max runs to return (default 20)"),
      },
      async ({ project_id, limit }, extra) => {
        const denied = requireScope(extra, "runs:read");
        if (denied) return denied;
        const supabase = createServiceClient();
        const runs = await listRuns(
          supabase,
          userIdOf(extra),
          project_id,
          limit ?? 20,
        );
        if (!runs) return toolError("Project not found.");
        return json({ runs });
      },
    );

    server.tool(
      "get_share_of_voice_report",
      "Share-of-voice report for a monitoring run: how often the brand and each competitor are mentioned in AI assistant answers, with share of voice, prominence, sentiment, and recommendation rate. Pass run_id, or just project_id for the latest completed run.",
      {
        run_id: z
          .string()
          .uuid()
          .optional()
          .describe("Run id from list_runs"),
        project_id: z
          .string()
          .uuid()
          .optional()
          .describe("If run_id is omitted: use this project's latest completed run"),
      },
      async ({ run_id, project_id }, extra) => {
        const denied = requireScope(extra, "runs:read");
        if (denied) return denied;
        const supabase = createServiceClient();
        const userId = userIdOf(extra);

        let targetRunId = run_id ?? null;
        if (!targetRunId && project_id) {
          const latest = await latestCompletedRun(supabase, userId, project_id);
          if (!latest) {
            return toolError(
              "No completed runs for that project yet. Trigger one with trigger_run.",
            );
          }
          targetRunId = latest.id;
        }
        if (!targetRunId) {
          return toolError("Pass run_id or project_id.");
        }

        const report = await getRunReport(supabase, userId, targetRunId);
        if (!report) return toolError("Run not found.");
        return json(report);
      },
    );

    server.tool(
      "trigger_run",
      "Execute a monitoring run now for a project: queries the configured AI assistant with every active prompt and stores mention data. Requires the account's own provider key (free-trial runs are dashboard-only). Can take a few minutes.",
      {
        project_id: z.string().uuid().describe("Project id from list_projects"),
      },
      async ({ project_id }, extra) => {
        const denied = requireScope(extra, "runs:trigger");
        if (denied) return denied;
        const supabase = createServiceClient();
        try {
          const outcome = await triggerRunForProject(
            supabase,
            userIdOf(extra),
            project_id,
          );
          if (!outcome.ok) return toolError(outcome.message);
          return json(outcome.result);
        } catch (e) {
          return toolError(humanError(e));
        }
      },
    );
  },
  {
    serverInfo: { name: "lettertrace", version: "1.0.0" },
    capabilities: {
      tools: {},
    },
  },
  {
    basePath: "/api/mcp",
    maxDuration,
    disableSse: true,
  },
);

// Bearer auth with Lettertrace credentials (classic API keys or OAuth access
// tokens). verifyToken stashes the owner's user id, the granted scopes, and the
// OAuth client id in AuthInfo.extra, which tool callbacks read via
// extra.authInfo. An OAuth token minted for the REST API (aud=v1) is rejected
// here so a token can only ever drive the surface it was consented for.
const verifyToken = async (
  _req: Request,
  token?: string,
): Promise<AuthInfo | undefined> => {
  const auth = await authenticateApiKey(token);
  if (!auth) return undefined;
  if (!allowsAudience(auth, "mcp")) return undefined;
  return {
    token: token!,
    // Prefer the real OAuth client id for audit; fall back to the user id for a
    // classic API key (preserving prior behavior for withMcpAuth).
    clientId: auth.clientId ?? auth.userId,
    scopes: auth.scopes ?? [],
    extra: {
      userId: auth.userId,
      keyId: auth.keyId,
      scopes: auth.scopes ?? [],
      clientId: auth.clientId,
    },
  };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
