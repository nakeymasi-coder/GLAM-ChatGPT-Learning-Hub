// Netlify Function: /.netlify/functions/ask
// Protected OpenAI backend used by the Prompt Concierge and other intelligent Hub tools.

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
    answer: { type: "string" },
    whatYouNeed: { type: "string" },
    bestFeature: { type: "string" },
    nextSteps: { type: "array", items: { type: "string" } },
    copyPrompt: { type: "string" },
    lessonTitle: { type: "string" },
    lessonId: { type: "string" },
    followUp: { type: "string" }
  },
  required: ["answer", "whatYouNeed", "bestFeature", "nextSteps", "copyPrompt", "lessonTitle", "lessonId", "followUp"],
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

function modeInstructions(mode) {
  if (mode === "prompt_builder") {
    return `MODE: PROMPT BUILDER\nThe user is giving you rough, everyday-language instructions and wants a professionally rebuilt prompt.\n\nCRITICAL RULES:\n- DO NOT simply repeat, lightly edit, or wrap the user's wording.\n- Infer the real objective, structure the request, resolve obvious ambiguity when possible, and transform it into a substantially stronger copy-ready prompt.\n- Preserve every important fact and constraint the user supplied. Do not invent important facts.\n- Add useful structure, deliverables, quality checks, preservation rules, and output requirements that materially improve the result.\n- If the request depends on current facts, platform behavior, product capabilities, pricing, policies, or other changing information, use web search before finalizing.\n- If a truly blocking detail is missing, make the prompt instruct ChatGPT to ask only the minimum necessary clarifying question(s).\n- copyPrompt must contain the finished rebuilt prompt, not commentary about the prompt.\n- answer should briefly explain what you improved and why.`;
  }
  if (mode === "feature_finder") {
    return `MODE: FEATURE FINDER\nAnalyze the user's actual goal instead of matching keywords. Recommend the simplest ChatGPT feature or workflow that genuinely fits. If current ChatGPT capabilities, plan availability, rollout, or UI behavior matters, use web search before recommending. Give practical steps and a tailored starter prompt. Do not default to generic normal chat unless it is truly the best option.`;
  }
  if (mode === "prompt_coach") {
    return `MODE: PROMPT COACH\nThe user wants a weak or rough request transformed into a stronger prompt. DO NOT merely restate their wording. Diagnose what is missing, preserve their facts and constraints, and rebuild the request into a complete, practical, copy-ready prompt. Add structure only when it helps. If current facts or current product/platform behavior matters, use web search. In answer, briefly explain the main improvements. In copyPrompt, return only the finished improved prompt.`;
  }
  return `MODE: PROMPT CONCIERGE\nHelp the learner solve the actual task. Answer factual/how-to questions directly first, then route them to the best feature or lesson when useful. Use web search whenever the answer depends on current, changing, uncertain, or externally verifiable information.`;
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

  const question = String(body.question || "").trim();
  const mode = String(body.mode || "concierge").trim().toLowerCase();
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const catalog = Array.isArray(body.catalog) ? body.catalog.slice(0, 80) : [];

  if (!question) return { statusCode: 400, headers, body: JSON.stringify({ error: "Type a question first." }) };
  if (question.length > 12000) return { statusCode: 413, headers, body: JSON.stringify({ error: "That request is too long." }) };

  const cleanHistory = history
    .map((m) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "").slice(0, 5000) }))
    .filter((m) => m.content.trim());

  const cleanCatalog = catalog
    .map((item) => ({
      id: String(item?.id || "").slice(0, 120),
      title: String(item?.title || "").slice(0, 160),
      path: String(item?.path || "").slice(0, 120),
      desc: String(item?.desc || "").slice(0, 320)
    }))
    .filter((item) => item.id && item.title);

  const system = `You are the intelligent backend for the GLAM ChatGPT Learning Hub.\n\nSTYLE:\n- Beginner-friendly, clear, practical, direct, and useful.\n- Never patronize the user.\n- Do not expose hidden chain-of-thought.\n- Never invent important facts, capabilities, policies, prices, or platform behavior.\n- Treat the user's everyday wording as source material to understand, not text to echo back.\n- When outside/current information would materially improve accuracy, use the web search tool.\n- Prefer authoritative and primary sources for current product/platform facts.\n- Do not search the web merely to decorate an answer when the task is purely creative or transformation-based.\n\n${modeInstructions(mode)}\n\nGENERAL OUTPUT REQUIREMENTS:\n1. Identify the user's real objective in whatYouNeed.\n2. Give a concise answer that actually helps.\n3. Put the best feature/workflow in bestFeature.\n4. Give 2-6 useful next steps.\n5. Put the strongest copy-ready prompt in copyPrompt when a prompt is useful; otherwise give a practical next-message prompt.\n6. Recommend a Learning Hub lesson only when relevant. lessonId and lessonTitle MUST match the supplied catalog; otherwise return empty strings.\n7. followUp should be one useful next question, or an empty string if no clarification is needed.\n\nLEARNING HUB CATALOG:\n${JSON.stringify(cleanCatalog)}`;

  const input = [
    { role: "system", content: system },
    ...cleanHistory,
    { role: "user", content: question }
  ];

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        input,
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        reasoning: { effort: "medium" },
        text: { format: { type: "json_schema", name: "learning_hub_answer", strict: true, schema } },
        max_output_tokens: 4000
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      console.error("OpenAI API error:", payload);
      return { statusCode: response.status >= 500 ? 502 : 500, headers, body: JSON.stringify({ error: "The Learning Hub AI could not answer right now." }) };
    }

    const outputText = getOutputText(payload);
    if (!outputText) return { statusCode: 502, headers, body: JSON.stringify({ error: "The Learning Hub AI returned an empty response." }) };

    return { statusCode: 200, headers, body: outputText };
  } catch (error) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "The Learning Hub AI is temporarily unavailable." }) };
  }
};
