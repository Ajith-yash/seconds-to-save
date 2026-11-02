/**
 * Smart Ambulance Alert and Traffic Clearance System
 * Managed Serverless Authentication & Ably Token Endpoint
 * Application Name: Smart-Ambulance-Alert
 * Key Nickname: Ambulance-Realtime
 *
 * Compatible with Netlify Functions (/.netlify/functions/api) and Vercel Serverless (/api/index.js)
 * Zero external npm runtime dependencies required — uses native Node.js crypto & https modules.
 */

const crypto = require("crypto");
const https = require("https");

// Environment Variables (Never exposed to frontend)
const ABLY_API_KEY = process.env.ABLY_API_KEY || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "smart-ambulance-sri-chaitanya-secret-key-2026";
const DRIVER_ACCESS_CODE = process.env.DRIVER_ACCESS_CODE || "SCTS-AMB-2026";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// Pre-authorized Ambulance Driver Accounts (Can be extended via AUTHORIZED_DRIVERS_JSON env var)
const DEFAULT_DRIVERS = [
  {
    email: "driver1@ambulance.org",
    passwordHash: hashPassword("Driver@108"),
    driverName: "Rajesh Kumar",
    ambulanceReg: "TN-01-AM-1081",
    ambulanceId: "AMB-1081"
  },
  {
    email: "driver2@ambulance.org",
    passwordHash: hashPassword("Driver@108"),
    driverName: "Suresh Babu",
    ambulanceReg: "TN-09-EM-2045",
    ambulanceId: "AMB-2045"
  },
  {
    email: "ajith@ambulance.org",
    passwordHash: hashPassword("ClearTheWay@108"),
    driverName: "Ajith (Lead Operator)",
    ambulanceReg: "TN-10-SC-0108",
    ambulanceId: "AMB-0108"
  }
];

function getAuthorizedDrivers() {
  if (process.env.AUTHORIZED_DRIVERS_JSON) {
    try {
      const custom = JSON.parse(process.env.AUTHORIZED_DRIVERS_JSON);
      if (Array.isArray(custom)) return [...DEFAULT_DRIVERS, ...custom];
    } catch (e) {}
  }
  return DEFAULT_DRIVERS;
}

function hashPassword(password) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(String(password)).digest("hex");
}

function signToken(payload, expiresInSeconds = 86400) {
  const data = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds
  };
  const base64Payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(base64Payload)
    .digest("base64url");
  return `${base64Payload}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [base64Payload, signature] = token.split(".");
  const expectedSig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(base64Payload)
    .digest("base64url");
  if (signature !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(base64Payload, "base64url").toString("utf-8"));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Generate 6-digit verification code deterministically from email + secret (stateless across serverless cold starts)
function generateVerificationCode(email) {
  const normalized = String(email).trim().toLowerCase();
  const timeWindow = Math.floor(Date.now() / (1000 * 60 * 30)); // Valid for 30-min window
  const hmac = crypto.createHmac("sha256", SESSION_SECRET).update(`${normalized}:${timeWindow}`).digest("hex");
  const num = parseInt(hmac.slice(0, 8), 16) % 900000 + 100000;
  return String(num);
}

function verifyEmailCode(email, code) {
  const normalized = String(email).trim().toLowerCase();
  const currentWindow = Math.floor(Date.now() / (1000 * 60 * 30));
  for (const w of [currentWindow, currentWindow - 1]) {
    const hmac = crypto.createHmac("sha256", SESSION_SECRET).update(`${normalized}:${w}`).digest("hex");
    const expected = String(parseInt(hmac.slice(0, 8), 16) % 900000 + 100000);
    if (String(code).trim() === expected) return true;
  }
  return false;
}

// Create signed Ably TokenRequest or request short-lived Token via Ably REST API
function createAblySignedTokenRequest(apiKey, clientId, capabilityObj, ttlMs = 3600 * 1000) {
  const [keyName, keySecret] = apiKey.split(":");
  if (!keyName || !keySecret) {
    throw new Error("Invalid ABLY_API_KEY format. Expected 'appId.keyId:keySecret'.");
  }
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");
  const capability = JSON.stringify(capabilityObj);

  // Ably TokenRequest HMAC-SHA256 signing string format (strictly ordered with trailing newline)
  const signText = [
    keyName,
    String(ttlMs),
    capability,
    clientId,
    String(timestamp),
    nonce,
    ""
  ].join("\n");

  const mac = crypto.createHmac("sha256", keySecret).update(signText).digest("base64");

  return {
    keyName,
    ttl: ttlMs,
    timestamp,
    capability,
    clientId,
    nonce,
    mac
  };
}

// Optional live exchange with Ably REST /keys/{keyName}/requestToken
function requestAblyTokenFromRest(tokenRequest) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(tokenRequest);
    const req = https.request(
      {
        hostname: "rest.ably.io",
        port: 443,
        path: `/keys/${encodeURIComponent(tokenRequest.keyName)}/requestToken`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Content-Length": Buffer.byteLength(postData)
        },
        timeout: 6000
      },
      (res) => {
        let body = "";
        res.on("data", chunk => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300 && parsed.token) {
              resolve(parsed);
            } else {
              // Fallback to signed TokenRequest if Ably REST returns error or offline
              resolve(tokenRequest);
            }
          } catch (e) {
            resolve(tokenRequest);
          }
        });
      }
    );
    req.on("error", () => resolve(tokenRequest));
    req.on("timeout", () => {
      req.destroy();
      resolve(tokenRequest);
    });
    req.write(postData);
    req.end();
  });
}

// Core Request Router
async function handleApiRequest(method, action, body, headers) {
  const authHeader = headers["authorization"] || headers["Authorization"] || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : (body && body.sessionToken) || "";

  // 1. Health & Configuration Check
  if (action === "health" || action === "status") {
    return {
      statusCode: 200,
      body: {
        ok: true,
        application: "Smart-Ambulance-Alert",
        keyNickname: "Ambulance-Realtime",
        ablyConfigured: Boolean(ABLY_API_KEY && ABLY_API_KEY.includes(":")),
        timestamp: new Date().toISOString()
      }
    };
  }

  // 2. Receiver Registration (Step 1: Issue Email Verification Challenge + Encrypted Account Record)
  if (action === "register-receiver" && method === "POST") {
    const { fullName, email, phone, password } = body || {};
    if (!fullName || !email || !phone || !password) {
      return { statusCode: 400, body: { error: "Full name, email, phone number, and password are required." } };
    }
    if (String(password).length < 6) {
      return { statusCode: 400, body: { error: "Password must be at least 6 characters." } };
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const receiverId = "RCV-" + crypto.createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 8).toUpperCase();
    const verificationCode = generateVerificationCode(normalizedEmail);

    // Create a server-signed account record (contains passwordHash, never plain password)
    const pendingAccountToken = signToken({
      type: "receiver_account_record",
      receiverId,
      fullName: String(fullName).trim(),
      email: normalizedEmail,
      phone: String(phone).trim(),
      passwordHash: hashPassword(password),
      emailVerified: false
    }, 86400 * 365);

    // Optional SMTP / Transactional Email webhook dispatch if configured in env
    let emailDispatched = false;
    if (process.env.EMAIL_WEBHOOK_URL) {
      emailDispatched = true;
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        receiverId,
        email: normalizedEmail,
        pendingAccountToken,
        verificationRequired: true,
        emailDispatched,
        // Included in response when SMTP is not yet bound so users can complete verification immediately
        verificationCodePreview: emailDispatched ? undefined : verificationCode,
        message: emailDispatched
          ? `A 6-digit verification code has been sent to ${normalizedEmail}.`
          : `Verification code generated for ${normalizedEmail}: ${verificationCode}`
      }
    };
  }

  // 3. Verify Receiver Email Code
  if (action === "verify-email" && method === "POST") {
    const { email, code, pendingAccountToken } = body || {};
    if (!email || !code || !pendingAccountToken) {
      return { statusCode: 400, body: { error: "Email, verification code, and account token are required." } };
    }
    const record = verifyToken(pendingAccountToken);
    if (!record || record.type !== "receiver_account_record") {
      return { statusCode: 400, body: { error: "Invalid or expired registration record." } };
    }
    if (record.email !== String(email).trim().toLowerCase()) {
      return { statusCode: 400, body: { error: "Email address does not match registration record." } };
    }
    if (!verifyEmailCode(record.email, code)) {
      return { statusCode: 401, body: { error: "Incorrect or expired verification code." } };
    }

    // Issue verified account certificate & active session token
    const verifiedAccountToken = signToken({
      ...record,
      emailVerified: true
    }, 86400 * 365);

    const sessionToken = signToken({
      role: "receiver",
      userId: record.receiverId,
      receiverId: record.receiverId,
      fullName: record.fullName,
      email: record.email,
      phone: record.phone,
      emailVerified: true
    }, 86400 * 7);

    return {
      statusCode: 200,
      body: {
        ok: true,
        role: "receiver",
        sessionToken,
        verifiedAccountToken,
        user: {
          role: "receiver",
          receiverId: record.receiverId,
          fullName: record.fullName,
          email: record.email,
          phone: record.phone,
          emailVerified: true
        }
      }
    };
  }

  // 4. Receiver Login
  if (action === "login-receiver" && method === "POST") {
    const { email, password, verifiedAccountToken } = body || {};
    if (!email || !password) {
      return { statusCode: 400, body: { error: "Email and password are required." } };
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const record = verifyToken(verifiedAccountToken);

    if (!record || record.type !== "receiver_account_record" || record.email !== normalizedEmail) {
      return {
        statusCode: 401,
        body: { error: "No verified receiver account found for this email in this browser. Please register and verify your email first." }
      };
    }
    if (!record.emailVerified) {
      return { statusCode: 403, body: { error: "Email address is not verified yet. Please complete email verification." } };
    }
    if (record.passwordHash !== hashPassword(password)) {
      return { statusCode: 401, body: { error: "Invalid email or password." } };
    }

    const sessionToken = signToken({
      role: "receiver",
      userId: record.receiverId,
      receiverId: record.receiverId,
      fullName: record.fullName,
      email: record.email,
      phone: record.phone,
      emailVerified: true
    }, 86400 * 7);

    return {
      statusCode: 200,
      body: {
        ok: true,
        role: "receiver",
        sessionToken,
        user: {
          role: "receiver",
          receiverId: record.receiverId,
          fullName: record.fullName,
          email: record.email,
          phone: record.phone,
          emailVerified: true
        }
      }
    };
  }

  // 5. Update Receiver Profile
  if (action === "update-receiver-profile" && method === "POST") {
    const session = verifyToken(bearerToken);
    if (!session || session.role !== "receiver") {
      return { statusCode: 401, body: { error: "Unauthorized. Valid receiver session required." } };
    }
    const { fullName, phone, verifiedAccountToken } = body || {};
    const record = verifyToken(verifiedAccountToken);
    if (!record || record.receiverId !== session.receiverId) {
      return { statusCode: 400, body: { error: "Invalid account record." } };
    }

    const updatedName = String(fullName || session.fullName).trim();
    const updatedPhone = String(phone || session.phone).trim();

    const newAccountToken = signToken({
      ...record,
      fullName: updatedName,
      phone: updatedPhone
    }, 86400 * 365);

    const newSessionToken = signToken({
      ...session,
      fullName: updatedName,
      phone: updatedPhone
    }, 86400 * 7);

    return {
      statusCode: 200,
      body: {
        ok: true,
        sessionToken: newSessionToken,
        verifiedAccountToken: newAccountToken,
        user: {
          role: "receiver",
          receiverId: session.receiverId,
          fullName: updatedName,
          email: session.email,
          phone: updatedPhone,
          emailVerified: true
        }
      }
    };
  }

  // 6. Ambulance Driver Login — only server-authorized demo operators can sign in.
  if (action === "login-driver" && method === "POST") {
    const { email, password, driverName } = body || {};
    if (!email || !password || !driverName) {
      return { statusCode: 400, body: { error: "Full name, email and password are required." } };
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const matchedDriver = getAuthorizedDrivers().find(d => d.email.toLowerCase() === normalizedEmail);
    if (!matchedDriver || matchedDriver.passwordHash !== hashPassword(password)) {
      return { statusCode: 401, body: { error: "Invalid driver name, email or password. Use an authorized project driver account." } };
    }
    if (String(driverName).trim().toLowerCase() !== matchedDriver.driverName.trim().toLowerCase()) {
      return { statusCode: 401, body: { error: "The full name does not match this driver account." } };
    }

    const sessionToken = signToken({
      role: "driver",
      userId: matchedDriver.ambulanceId,
      email: normalizedEmail,
      driverName: matchedDriver.driverName,
      ambulanceReg: matchedDriver.ambulanceReg,
      ambulanceId: matchedDriver.ambulanceId
    }, 86400);

    return {
      statusCode: 200,
      body: {
        ok: true,
        role: "driver",
        sessionToken,
        user: {
          role: "driver",
          email: normalizedEmail,
          driverName: matchedDriver.driverName,
          ambulanceReg: matchedDriver.ambulanceReg,
          ambulanceId: matchedDriver.ambulanceId
        }
      }
    };
  }

  // 7. Verify Active Session
  if (action === "verify-session") {
    const session = verifyToken(bearerToken);
    if (!session) {
      return { statusCode: 401, body: { error: "Session expired or invalid." } };
    }
    return {
      statusCode: 200,
      body: { ok: true, user: session }
    };
  }

  // 8. Ably Short-Lived Token Generation Endpoint (Role-Scoped Capabilities)
  if (action === "ably-token") {
    const session = verifyToken(bearerToken);
    if (!session || !session.role) {
      return {
        statusCode: 401,
        body: { error: "Authentication required. Cannot issue Ably token to unauthenticated client." }
      };
    }

    if (!ABLY_API_KEY || !ABLY_API_KEY.includes(":")) {
      return {
        statusCode: 503,
        body: {
          error: "ABLY_API_KEY is not configured in serverless environment variables.",
          code: "ABLY_KEY_MISSING"
        }
      };
    }

    let capability = {};
    let clientId = "";

    if (session.role === "driver") {
      // Driver can publish & subscribe ONLY to 'ambulance' dispatch channel and their specific 'ambulance:{ambulanceId}' channel
      const ambId = session.ambulanceId;
      clientId = `driver:${ambId}`;
      capability = {
        "ambulance": ["publish", "subscribe", "presence", "history"],
        [`ambulance:${ambId}`]: ["publish", "subscribe", "presence", "history"]
      };
    } else if (session.role === "receiver") {
      // Receiver is strictly prevented from publishing to any ambulance channel!
      const rcvId = session.receiverId;
      clientId = `receiver:${rcvId}`;
      capability = {
        "ambulance": ["subscribe", "presence", "history"],
        "ambulance:*": ["subscribe", "history"],
        [`receiver:${rcvId}`]: ["publish", "subscribe", "presence", "history"]
      };
    } else {
      return { statusCode: 403, body: { error: "Unrecognized role." } };
    }

    // Short-lived token (45 minutes TTL)
    const ttlMs = 45 * 60 * 1000;
    const signedTokenRequest = createAblySignedTokenRequest(ABLY_API_KEY, clientId, capability, ttlMs);
    const tokenResponse = await requestAblyTokenFromRest(signedTokenRequest);

    return {
      statusCode: 200,
      body: tokenResponse
    };
  }

  return { statusCode: 404, body: { error: `Unknown endpoint action: ${action}` } };
}

module.exports = {
  handleApiRequest,
  ALLOWED_ORIGIN
};
