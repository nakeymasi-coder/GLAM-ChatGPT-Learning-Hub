// Netlify Function: /.netlify/functions/coach
// Keep OPENAI_API_KEY in Netlify environment variables. Never put it in the browser HTML.

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_COACH_MODEL || "gpt-5.6-luna";

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
        properties: {
          item: { type: "string" },
          why: { type: "string" }
        },
        required: ["item", "why"],
        additionalProperties: false
      }
    },
    coachingTips: { type: "array", items: { type: "string" } },
    improvedPrompt: { type: "string" },
    whyBetter: { type: "string" },
    nextChallenge: { type: "string" }
  },
  required: [
    "score","headline","summary","interpretation","strengths","missing",
    "coachingTips","improvedPrompt","whyBetter","nextChallenge"
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
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "POST only." }) };
  }

  if (!process.env.OPENAI_API_KEY) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "OPENAI_API_KEY is not configured in Netlify." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid request." }) };
  }

  const attempt = String(body.attempt || "").trim();
  const lesson = body.lesson || {};

  if (!attempt) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "No attempt was provided." }) };
  }
  if (attempt.length > 8000) {
    return { statusCode: 413, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "That attempt is too long for this coaching exercise." }) };
  }

  const system = `You are the personalized Prompt Coach inside a beginner-friendly ChatGPT learning app.

Your job is to coach the USER'S EXACT ATTEMPT, not give generic prompting advice.

CORE RULES:
- First infer what the user is actually trying to accomplish from their wording and the current lesson.
- Identify only prompt components that are genuinely present. Never invent strengths.
- Identify only missing information that would materially improve THIS specific request.
- Do not mechanically demand audience, tone, context, examples, format, or role unless that item matters for this task.
- A short prompt can be excellent. Never reward length for its own sake.
- Do not punish the learner for not including information that ChatGPT would not need.
- If the learner wrote a constraint (for example "under 500 words"), explicitly recognize it.
- If they used a clear action verb (rewrite, summarize, compare, create, explain), explicitly recognize it.
- If they say "rewrite this prompt" but have not supplied the prompt being rewritten, call that out.
- Explain what ChatGPT would currently understand from their wording.
- Teach in plain English. Be direct and specific, not patronizing.
- The improvedPrompt must preserve the user's original intent and constraints. Do not quietly change the task.
- The improvedPrompt should be ready to copy and use.
- Scoring: 90-100 ready to use; 75-89 strong with small gaps; 55-74 workable but underspecified; 30-54 weak direction; 0-29 unclear.
- Do not expose chain-of-thought or hidden reasoning. Give concise coaching conclusions only.
- Return JSON matching the required schema.

CURRENT LESSON:
Title: ${String(lesson.title || "")}
Description: ${String(lesson.description || "")}
When this lesson is useful: ${String(lesson.use || "")}
Common mistake: ${String(lesson.commonMistake || "")}
Lesson steps: ${JSON.stringify(lesson.lessonSteps || [])}
Lesson example prompt: ${String(lesson.examplePrompt || "")}`;

  const user = `Coach this exact learner attempt:

${attempt}`;

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            name: "prompt_coaching",
            strict: true,
            schema
          }
        },
        max_output_tokens: 1400
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      console.error("OpenAI API error:", payload);
      return {
        statusCode: response.status >= 500 ? 502 : 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "The AI Coach could not generate feedback right now." })
      };
    }

    const outputText = getOutputText(payload);
    if (!outputText) {
      return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "The AI Coach returned an empty response." }) };
    }

    const coaching = JSON.parse(outputText);

    // Clamp the score on the server before returning it.
    coaching.score = Math.max(0, Math.min(100, Number(coaching.score) || 0));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify(coaching)
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "AI coaching is temporarily unavailable." })
    };
  }
};
