import crypto from "crypto"
import * as stateStore from "./oauth-state.store.js"

export class UnsupportedProviderError extends Error {
  constructor(provider) {
    super(`Unsupported provider: ${provider}`)
    this.name = "UnsupportedProviderError"
  }
}

export class InvalidStateError extends Error {
  constructor() {
    super("Invalid or expired state")
    this.name = "InvalidStateError"
  }
}

export class ProviderError extends Error {
  constructor(code) {
    super(`Provider returned error: ${code}`)
    this.name = "ProviderError"
    this.code = code
  }
}

const PROVIDERS = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scope: "openid email profile",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    extractProfile: (raw) => ({
      providerUserId: raw.sub,
      email: raw.email ?? null,
      username:
        raw.name || raw.email?.split("@")[0] || `google-${raw.sub.slice(0, 8)}`,
    }),
  },
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    profileUrl: "https://api.github.com/user",
    emailsUrl: "https://api.github.com/user/emails",
    scope: "read:user user:email",
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
    extractProfile: (raw, email) => ({
      providerUserId: String(raw.id),
      email: email ?? raw.email ?? null,
      username: raw.login || `github-${raw.id}`,
    }),
  },
}

function getProvider(name) {
  const p = PROVIDERS[name]
  if (!p) throw new UnsupportedProviderError(name)
  return p
}

function callbackUrl(provider) {
  return `${process.env.OAUTH_CALLBACK_BASE_URL}/api/v1/auth/${provider}/callback`
}

function pkce() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url")
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url")
  return { codeVerifier, codeChallenge }
}

export function buildAuthorizeUrl({ provider, clientType, display }) {
  const p = getProvider(provider)
  const state = crypto.randomBytes(16).toString("base64url")
  const { codeVerifier, codeChallenge } = pkce()

  stateStore.set(state, { codeVerifier, provider, clientType, display })

  const params = new URLSearchParams({
    client_id: p.clientId(),
    redirect_uri: callbackUrl(provider),
    response_type: "code",
    scope: p.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  })

  return { url: `${p.authorizeUrl}?${params.toString()}`, state }
}

export async function completeCallback({
  provider,
  code,
  state,
  providerError,
}) {
  if (providerError) throw new ProviderError(providerError)

  const entry = stateStore.consume(state)
  if (!entry || entry.provider !== provider) throw new InvalidStateError()

  const p = getProvider(provider)

  const tokenRes = await fetch(p.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: p.clientId(),
      client_secret: p.clientSecret(),
      code,
      redirect_uri: callbackUrl(provider),
      grant_type: "authorization_code",
      code_verifier: entry.codeVerifier,
    }).toString(),
  }).catch((err) => {
    console.error("TOKEN FETCH CAUSE:", JSON.stringify(err.cause))
    throw err
  })

  if (!tokenRes.ok) {
    const body = await tokenRes.text()
    throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`)
  }
  const tokenJson = await tokenRes.json()
  const accessToken = tokenJson.access_token
  if (!accessToken) throw new Error("No access_token in provider response")

  const profileRes = await fetch(p.profileUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "devflow-backend",
    },
  })
  if (!profileRes.ok)
    throw new Error(`Profile fetch failed: ${profileRes.status}`)
  const profile = await profileRes.json()

  let email
  if (provider === "github") {
    if (!profile.email) {
      const emailsRes = await fetch(p.emailsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": "devflow-backend",
        },
      })
      if (emailsRes.ok) {
        const emails = await emailsRes.json()
        const primary =
          emails.find((e) => e.primary && e.verified) ??
          emails.find((e) => e.verified)
        email = primary?.email
      }
    }
  }

  const extracted = p.extractProfile(profile, email)
  return { ...extracted, clientType: entry.clientType, display: entry.display }
}
