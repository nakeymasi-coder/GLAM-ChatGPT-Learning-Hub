// Netlify Function: /.netlify/functions/coach
// Keep OPENAI_API_KEY in Netlify environment variables. Never put it in browser HTML.

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_COACH_MODEL || "gpt-5.6-luna";
const APP_ID = "6a9aedd33cd938f0f47b9ff7";
const BASE44_API = "https://base44.app/api";
const TERMS_VERSION = "2026-09-07";
const PRIVACY_VERSION = "2026-09-07";
const ALLOWED_ORIGINS = new Set([
  "https://chatgpt-learning-hub.com",
  "https://chatgpt-learning-hub.base44.app",
  "https://app.base44.com",
  "https://nakeymasi-coder.github.io"
]);

function corsHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Vary": "Origin"
  };
  if (ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function getBearer(event) {
  const value = event?.headers?.authorization || event?.headers?.Authorization || "";
  return /^Bearer\s+\S+$/i.test(value) ? value : "";
}

function normalizeRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

async function verifyHubAccess(event) {
  const authorization = getBearer(event);
  if (!authorization) return { ok: false, status: 401, error: "Authentication required." };

  const me = await fetch(`${BASE44_API}/apps/${APP_ID}/entities/User/me`, {
    headers: { Authorization: authorization, Accept: "application/json" }
  });
  if (!me.ok) return { ok: false, status: 401, error: "Your Hub session is not valid. Please sign in again." };

  const user = await me.json();
  if (!user?.id) return { ok: false, status: 401, error: "Your Hub session could not be verified." };

  const legal = await fetch(`${BASE44_API}/apps/${APP_ID}/entities/LegalAcceptance?sort=-created_date&limit=50`, {
    headers: { Authorization: authorization, Accept: "application/json" }
  });
  if (!legal.ok) return { ok: false, status: 403, error: "Legal acceptance could not be verified." };

  const records = normalizeRecords(await legal.json());
  const accepted = records.some((record) => {
    const terms = record?.terms_version ?? record?.data?.terms_version;
    const privacy = record?.privacy_version ?? record?.data?.privacy_version;
    return terms === TERMS_VERSION && privacy === PRIVACY_VERSION;
  });

  if (!accepted) return { ok: false, status: 403, error: "Please accept the current Terms & Conditions and Privacy Policy before using AI features." };
  return { ok: true, user };
}

const schema = {
  type: "object",
  properties: {
    score: { type: "integer" },
    headline: { type: "string" },
    summary: { type: "string" },
    interpretation: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    missing: {
      type: "array",
      items: {
        type: "object",
        properties: { item: { type: "string" }, why: { type: "string" } },
        required: ["item", "why"],
        additionalProperties: false
      }
    },
    coachingTips: { type: "array", items: { type: "string" } },
    improvedPrompt: { type: "string" },
    whyBetter: { type: "string" },
    nextChallenge: { type: "string" }
  },
  required: ["score","headline","summary","interpretation","strengths","missing","coachingTips","improvedPrompt","whyBetter","nextChallenge"],
  additionalProperties: false
};

function getOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

exports.handler = async function(event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only." }) };

  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Origin not allowed." }) };
  }

  let access;
  try {
    access = await verifyHubAccess(event);
  } catch (error) {
    console.error("Base44 access verification failed", error);
    return { statusCode: 503, headers, body: JSON.stringify({ error: "Could not verify Hub access right now." }) };
  }
  if (!access.ok) return { statusCode: access.status, headers, body: JSON.stringify({ error: access.error }) };

  if (!process.env.OPENAI_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "AI service is not configured." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request." }) };
  }

  const attempt = String(body.attempt || "").trim();
  const lesson = body.lesson || {};

  if (!attempt) return { statusCode: 400, headers, body: JSON.stringify({ error: "No attempt was provided." }) };
  if (attempt.length > 8000) return { statusCode: 413, headers, body: JSON.stringify({ error: "That attempt is too long for this coaching exercise." }) };

  const system = `You are the personalized Prompt Coach inside a beginner-friendly ChatGPT learning app.\n\nYour job is to coach the USER'S EXACT ATTEMPT, not give generic prompting advice.\n\nCORE RULES:\n- First infer what the user is actually trying to accomplish from their wording and the current lesson.\n- Identify only prompt components that are genuinely present. Never invent strengths.\n- Identify only missing information that would materially improve THIS specific request.\n- Do not mechanically demand audience, tone, context, examples, format, or role unless that item matters for this task.\n- A short prompt can be excellent. Never reward length for its own sake.\n- Do not punish the learner for not including information that ChatGPT would not need.\n- If the learner wrote a constraint, explicitly recognize it.\n- If they used a clear action verb, explicitly recognize it.\n- If they say "rewrite this prompt" but have not supplied the prompt being rewritten, call that out.\n- Explain what ChatGPT would currently understand from their wording.\n- Teach in plain English. Be direct and specific, not patronizing.\n- The improvedPrompt must preserve the user's original intent and constraints. Do not quietly change the task.\n- The improvedPrompt should be ready to copy and use.\n- Scoring: 90-100 ready to use; 75-89 strong with small gaps; 55-74 workable but underspecified; 30-54 weak direction; 0-29 unclear.\n- Do not expose chain-of-thought or hidden reasoning. Give concise coaching conclusions only.\n- Return JSON matching the required schema.\n\nCURRENT LESSON:\nTitle: ${String(lesson.title || "")}\nDescription: ${String(lesson.description || "")}\nWhen this lesson is useful: ${String(lesson.use || "")}\nCommon mistake: ${String(lesson.commonMistake || "")}\nLesson steps: ${JSON.stringify(lesson.lessonSteps || [])}\nLesson example prompt: ${String(lesson.examplePrompt || "")}`;

  const user = `Coach this exact learner attempt:\n\n${attempt}`;

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        input: [{ role: "system", content: system }, { role: "user", content: user }],
        reasoning: { effort: "low" },
        text: { format: { type: "json_schema", name: "prompt_coaching", strict: true, schema } },
        max_output_tokens: 4000
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      console.error("OpenAI API error:", payload);
      return { statusCode: response.status >= 500 ? 502 : 500, headers, body: JSON.stringify({ error: "The AI Coach could not generate feedback right now." }) };
    }

    const outputText = getOutputText(payload);
    if (!outputText) return { statusCode: 502, headers, body: JSON.stringify({ error: "The AI Coach returned an empty response." }) };

    const coaching = JSON.parse(outputText);
    coaching.score = Math.max(0, Math.min(100, Number(coaching.score) || 0));

    return { statusCode: 200, headers, body: JSON.stringify(coaching) };
  } catch (error) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "AI coaching is temporarily unavailable." }) };
  }
};
