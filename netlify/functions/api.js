const { handleApiRequest, ALLOWED_ORIGIN } = require("./core");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    const query = event.queryStringParameters || {};
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        // Handle URL-encoded params if Ably SDK sends form params
        const params = new URLSearchParams(event.body);
        for (const [k, v] of params.entries()) body[k] = v;
      }
    }

    const pathParts = (event.path || "").split("/").filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];
    const action = query.action || body.action || (lastPart !== "api" ? lastPart : "status");

    // Support bearer token passed in query string for Ably authUrl callbacks
    const mergedHeaders = { ...event.headers };
    if (!mergedHeaders.authorization && !mergedHeaders.Authorization && query.sessionToken) {
      mergedHeaders.Authorization = `Bearer ${query.sessionToken}`;
    }

    const result = await handleApiRequest(event.httpMethod, action, body, mergedHeaders);
    return {
      statusCode: result.statusCode,
      headers,
      body: JSON.stringify(result.body)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal serverless error", details: err.message })
    };
  }
};
