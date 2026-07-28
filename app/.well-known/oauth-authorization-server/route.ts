import { NextResponse } from "next/server";
import { KNOWN_SCOPES, siteBase } from "@/lib/oauth";

export const dynamic = "force-dynamic";

// RFC 8414 Authorization Server Metadata. Public and CORS-open so that browser
// and desktop OAuth/MCP clients can discover how to authenticate. Only the
// endpoints that actually exist are advertised; the device-authorization and
// dynamic-registration endpoints are added when those flows ship.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function GET(request: Request) {
  const base = siteBase(request);
  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    scopes_supported: [...KNOWN_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    authorization_response_iss_parameter_supported: true,
  };
  return NextResponse.json(metadata, {
    headers: { ...CORS, "cache-control": "public, max-age=600" },
  });
}
