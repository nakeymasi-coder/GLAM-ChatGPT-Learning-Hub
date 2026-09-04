// Netlify Function: /.netlify/functions/ask
// Uses the same protected OPENAI_API_KEY as the Prompt Coach.

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_COACH_MODEL || "gpt-5.6-luna";

const ALLOWED_ORIGINS = new Set([
  "https://nakeymasi-coder.github.io",
  "https://chatgpt-learning-hub.netlify.app"
]);

function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://nakeymasi-coder.github.io",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
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
  required: [
    "answer",
    "whatYouNeed",
    "bestFeature",
    "nextSteps",
    "copyPrompt",
    "lessonTitle",
    "lessonId",
    "followUp"
  ],
  additionalProperties: false
};

function getOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return "";
}

exports.handler = async function(event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "POST only." })
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "OPENAI_API_KEY is not configured in Netlify." })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request." })
    };
  }

  const question = String(body.question || "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const catalog = Array.isArray(body.catalog) ? body.catalog.slice(0, 80) : [];

  if (!question) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Type a question first." })
    };
  }

  if (question.length > 5000) {
    return {
      statusCode: 413,
      headers,
      body: JSON.stringify({ error: "That question is too long." })
    };
  }

  const cleanHistory = history
    .map((m) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String((m && m.content) || "").slice(0, 3000)
    }))
    .filter((m) => m.content.trim());

  const cleanCatalog = catalog
    .map((item) => ({
      id: String(item?.id || "").slice(0, 120),
      title: String(item?.title || "").slice(0, 160),
      path: String(item?.path || "").slice(0, 120),
      desc: String(item?.desc || "").slice(0, 320)
    }))
    .filter((item) => item.id && item.title);

  const system = `You are the real-time Ask ChatGPT guide inside the GLAM ChatGPT Learning Hub.

Your job is to help a learner who may not know where to start.

STYLE:
- Be beginner-friendly, clear, practical, and direct.
- Never make the user feel stupid for not knowing terminology.
- Do not expose hidden chain-of-thought.
- Do not invent product features or claim a ChatGPT capability exists if it is uncertain.
- When a feature may depend on plan, platform, region, workspace, or rollout, say so briefly.

WHAT TO DO FOR EACH QUESTION:
1. Identify what the learner is actually trying to accomplish.
2. Recommend the best ChatGPT feature or workflow for that goal.
3. Give 2-5 simple next steps.
4. Give one ready-to-copy prompt tailored to the learner's goal.
5. Recommend the closest Learning Hub lesson from the catalog below.
6. End with one useful follow-up question that helps the learner continue.

IMPORTANT:
- If the user says they do not know where to start, help them narrow the goal before overloading them.
- If the user asks a normal factual or how-to question, answer it first, then route them to the best feature/lesson if useful.
- The recommended lessonId and lessonTitle MUST come from the supplied catalog when a suitable match exists. If no suitable lesson exists, return empty strings for both.

LEARNING HUB CATALOG:
${JSON.stringify(cleanCatalog)}`;

  const input = [
    { role: "system", content: system },
    ...cleanHistory,
    { role: "user", content: question }
  ];

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        input,
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            name: "learning_hub_answer",
            strict: true,
            schema
          }
        },
        max_output_tokens: 2200
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      console.error("OpenAI API error:", payload);
      return {
        statusCode: response.status >= 500 ? 502 : 500,
        headers,
        body: JSON.stringify({ error: "The Ask ChatGPT guide could not answer right now." })
      };
    }

    const outputText = getOutputText(payload);
    if (!outputText) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "The Ask ChatGPT guide returned an empty response." })
      };
    }

    return {
      statusCode: 200,
      headers: {
        ...headers,
        "Cache-Control": "no-store"
      },
      body: outputText
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Ask ChatGPT is temporarily unavailable." })
    };
  }
};
