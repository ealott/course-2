import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authRoutes, loadUser, meRoutes, requireUser, toMe } from "./auth";
import { groupRoutes } from "./groups";
import { haulRoutes } from "./hauls";
import type { AppEnv } from "./lib";

const app = new Hono<AppEnv>();

// CSRF: state-changing API calls must come from our own pages. Browsers won't let
// another site add a custom header without a CORS preflight, which we never grant.
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (c.req.header("x-haulsplit") !== "1" || (origin && origin !== new URL(c.req.url).origin)) {
      return c.json({ error: "Request blocked." }, 403);
    }
  }
  await next();
});

app.use("/api/*", loadUser);

const PUBLIC = [/^\/api\/config$/, /^\/api\/session$/, /^\/api\/auth\/(start|login|link|logout)$/, /^\/api\/invites\/[^/]+$/];
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isPublic = PUBLIC.some((re) => re.test(path)) && !(path.startsWith("/api/invites/") && c.req.method !== "GET");
  if (isPublic) return next();
  return requireUser(c, next);
});

app.get("/api/config", (c) => c.json({ aiReceipts: !!c.env.ANTHROPIC_API_KEY }));
// Like /api/me, but answers "nobody" instead of 401 so the app can check quietly on startup.
app.get("/api/session", (c) => {
  const user = c.get("user");
  return c.json({ me: user ? toMe(user) : null });
});

app.route("/api", authRoutes);
app.route("/api", meRoutes);
app.route("/api", groupRoutes);
app.route("/api", haulRoutes);

app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

// Everything else is the single-page app (normally served by the assets layer before we run).
app.all("*", (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Not found", 404)));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Something went wrong. Try again." }, 500);
});

export default app;
