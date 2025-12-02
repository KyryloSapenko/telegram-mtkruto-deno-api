import { Hono } from "@hono/hono";
import {
  sendToMe,
  sendMessageToUser,
  listingForMessages,
  registerUserFirstStep,
  registerUserSecondStep,
  clearTriggersForUser,
} from "DenoTelegram/telegram/client.ts";

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ ok: true });
});

app.post("/send-to-me", async (c) => {

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== "string" || typeof body.from !== "string") {
    return c.json({ error: "Fields `text` and `from` are required" }, 400);
  }

  await sendToMe(body.from, body.text);
  return c.json({ ok: true });
});

app.post("/send-to-user", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.from !== "string" || typeof body.text !== "string" || typeof body.to !== "string") {
        return c.json({ error: "Fields `from`, `to`, and `text` are required" }, 400);
    }
    await sendMessageToUser(body.from, body.to, body.text);
    return c.json({ ok: true });
});

app.post("/trigger-message", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.username !== "string" || typeof body.trigger !== "string" || typeof body.reply !== "string") {
    return c.json({ error: "Fields `username`, `trigger`, and `reply` are required" }, 400);
  }

  await listingForMessages(body.username, body.trigger, body.reply);
  return c.json({ ok: true });
});

app.delete("/trigger-message", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.username !== "string") {
        return c.json({ error: "Field `username` is required" }, 400);
    }
    await clearTriggersForUser(body.username);
    return c.json({ ok: true });
});
    

app.post("/register", async (c) => {
    const body = await c.req.json().catch(() => null);
  if (!body || typeof body.phone !== "string") {
    return c.json({ error: "Field `phone` is required" }, 400);
  }

  const result = await registerUserFirstStep(body.phone);
  return c.json({ ok: true, ...result });
});

app.post("/register/confirm", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.phone !== "string" || typeof body.code !== "string") {
    return c.json({ error: "Fields `phone` and `code` are required" }, 400);
  }

  const result = await registerUserSecondStep(body.phone, body.code, body.password);
  return c.json({ ok: true, ...result });
});

app.notFound((c) => {
  return c.text("Not found", 404);
});

export default app;
