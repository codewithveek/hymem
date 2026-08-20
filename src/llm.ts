import { config } from "./config.js";

export async function chat(system: string, user: string, temperature = 0): Promise<string> {
  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.llmModel,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}

/** Call the LLM expecting JSON; strip fences; retry once on parse failure. */
export async function chatJson<T>(system: string, user: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(system + "\nRespond with valid JSON only. No prose, no code fences.", user);
    const cleaned = raw.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      if (attempt === 1) throw new Error(`LLM returned unparseable JSON:\n${raw.slice(0, 400)}`);
    }
  }
  throw new Error("unreachable");
}
