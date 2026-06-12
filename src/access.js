import { createRemoteJWKSet, jwtVerify } from "jose";

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const jwksCache = new Map();

function normalizeTeamDomain(value) {
  const trimmed = String(value ?? "").trim();

  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function accessAudience(env) {
  const audience = String(env?.CLOUDFLARE_ACCESS_AUD ?? "").trim();

  if (!audience) {
    throw new Error("CLOUDFLARE_ACCESS_AUD is required.");
  }

  return audience;
}

function accessIssuer(env, teamDomain) {
  const configuredIssuer = String(env?.CLOUDFLARE_ACCESS_ISSUER ?? "").trim();
  return configuredIssuer || `https://${teamDomain}`;
}

function accessJwksUrl(env, teamDomain) {
  const explicitUrl = String(env?.CLOUDFLARE_ACCESS_JWKS_URL ?? "").trim();
  return explicitUrl || `https://${teamDomain}/cdn-cgi/access/certs`;
}

function remoteJwkSetFor(url) {
  if (!jwksCache.has(url)) {
    jwksCache.set(url, createRemoteJWKSet(new URL(url)));
  }

  return jwksCache.get(url);
}

export function normalizeAccessEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export async function authenticateAccessRequest(request, env) {
  const token = String(request.headers.get(ACCESS_JWT_HEADER) ?? "").trim();

  if (!token) {
    throw new Error("Missing required Cf-Access-Jwt-Assertion header.");
  }

  const teamDomain = normalizeTeamDomain(env?.CLOUDFLARE_ACCESS_TEAM_DOMAIN);

  if (!teamDomain) {
    throw new Error("CLOUDFLARE_ACCESS_TEAM_DOMAIN is required.");
  }

  const { payload } = await jwtVerify(token, remoteJwkSetFor(accessJwksUrl(env, teamDomain)), {
    audience: accessAudience(env),
    issuer: accessIssuer(env, teamDomain),
    algorithms: ["RS256"],
  });

  const email = normalizeAccessEmail(payload.email);

  if (!email) {
    throw new Error("Validated Access token did not include an email claim.");
  }

  return {
    email,
    subject: String(payload.sub ?? ""),
    payload,
  };
}
