import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS: lock to your Netlify frontend
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin === "*" ? true : [allowedOrigin],
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: false,
  })
);

// Health check
app.get("/", (req, res) => {
  res.type("text/plain").send("OK");
});

app.post("/api/chat", async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENROUTER_API_KEY" });
    }

    const {
      messages = [],
      model = "openrouter/auto",
      temperature = 0.7,
      top_p = 1,
      system = "",
    } = req.body || {};

    // Prepend system prompt if provided
    const payloadMessages = system
      ? [{ role: "system", content: system }, ...messages]
      : messages;

    const body = {
      model,
      messages: payloadMessages,
      temperature,
      top_p,
      stream: true,
    };

    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_SITE_URL || "https://example.com",
      "X-Title": "Glossy AI Chat",
    };

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    // Pipe OpenRouter SSE directly to client
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (k.toLowerCase() === "content-type") {
        res.setHeader("Content-Type", v); // should be text/event-stream
      }
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return res.status(upstream.status).send(text);
    }

    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upstream error", detail: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Proxy listening on :" + port));