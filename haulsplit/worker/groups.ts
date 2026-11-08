import { Hono } from "hono";
import { z } from "zod";
import type { GroupDetail, GroupSummary, HomeData, Member } from "../shared/api";
import { OWNER_LINK_TTL, body, createLoginLink, parse, toMe } from "./auth";
import { listHauls, requireMember, summarizeHauls } from "./data";
import { type AppEnv, all, fail, first, newId, newInviteCode, now, run, stmt } from "./lib";

export const groupRoutes = new Hono<AppEnv>();

const groupName = z.string().trim().min(1, "Give the group a name.").max(60);

groupRoutes.get("/home", async (c) => {
  const user = c.get("user");
  const groups = await all<{ id: string; name: string; owner_id: string; member_count: number }>(
    c.env.DB,
    `SELECT g.id, g.name, g.owner_id,
            (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS member_count
       FROM split_groups g JOIN group_members m ON m.group_id = g.id AND m.user_id = ?
      ORDER BY m.joined_at`,
    user.id,
  );
  const hauls = await summarizeHauls(c.env.DB, user.id, await listHauls(c.env.DB, user.id, "1 = 1"));
  const data: HomeData = {
    me: toMe(user),
    groups: groups.map<GroupSummary>((g) => ({ id: g.id, name: g.name, memberCount: g.member_count, isOwner: g.owner_id === user.id })),
    hauls,
  };
  return c.json(data);
});

groupRoutes.post("/groups", async (c) => {
  const input = parse(z.object({ name: groupName }), await body(c));
  const user = c.get("user");
  const id = newId();
  const t = now();
  await c.env.DB.batch([
    stmt(c.env.DB, "INSERT INTO split_groups (id, name, invite_code, owner_id, created_at) VALUES (?, ?, ?, ?, ?)", id, input.name, newInviteCode(), user.id, t),
    stmt(c.env.DB, "INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", id, user.id, t),
  ]);
  return c.json({ id });
});

groupRoutes.post("/invites/:code/join", async (c) => {
  const group = await first<{ id: string }>(c.env.DB, "SELECT id FROM split_groups WHERE invite_code = ?", c.req.param("code").toUpperCase());
  if (!group) fail(404, "That invite link isn't valid anymore. Ask for a new one.");
  await run(
    c.env.DB,
    "INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
    group.id,
    c.get("user").id,
    now(),
  );
  return c.json({ groupId: group.id });
});

groupRoutes.get("/groups/:id", async (c) => {
  const group = await requireMember(c, c.req.param("id"));
  const user = c.get("user");
  const members = await all<{ id: string; name: string; has_password: number; has_session: number }>(
    c.env.DB,
    `SELECT u.id, u.name, u.password_hash IS NOT NULL AS has_password,
            EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS has_session
       FROM group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ?
      ORDER BY m.joined_at`,
    now(),
    group.id,
  );
  const hauls = await summarizeHauls(c.env.DB, user.id, await listHauls(c.env.DB, user.id, "h.group_id = ?", group.id));
  const data: GroupDetail = {
    group: { id: group.id, name: group.name, inviteCode: group.invite_code, ownerId: group.owner_id },
    members: members.map<Member>((m) => ({
      id: m.id,
      name: m.name,
      hasPassword: !!m.has_password,
      canLogIn: !!m.has_password || !!m.has_session,
      isOwner: m.id === group.owner_id,
    })),
    hauls,
  };
  return c.json(data);
});

function requireOwner(group: { owner_id: string }, userId: string) {
  if (group.owner_id !== userId) fail(403, "Only the group's owner can do that.");
}

groupRoutes.patch("/groups/:id", async (c) => {
  const group = await requireMember(c, c.req.param("id"));
  requireOwner(group, c.get("user").id);
  const input = parse(z.object({ name: groupName }), await body(c));
  await run(c.env.DB, "UPDATE split_groups SET name = ? WHERE id = ?", input.name, group.id);
  return c.json({ ok: true });
});

groupRoutes.post("/groups/:id/invite/rotate", async (c) => {
  const group = await requireMember(c, c.req.param("id"));
  requireOwner(group, c.get("user").id);
  const code = newInviteCode();
  await run(c.env.DB, "UPDATE split_groups SET invite_code = ? WHERE id = ?", code, group.id);
  return c.json({ inviteCode: code });
});

/** Add someone who won't log in themselves (the organizer picks portions for them). */
groupRoutes.post("/groups/:id/members", async (c) => {
  const group = await requireMember(c, c.req.param("id"));
  const input = parse(z.object({ name: z.string().trim().min(1, "Enter a name.").max(60) }), await body(c));
  const id = newId();
  const t = now();
  await c.env.DB.batch([
    stmt(c.env.DB, "INSERT INTO users (id, name, created_by, created_at) VALUES (?, ?, ?, ?)", id, input.name, c.get("user").id, t),
    stmt(c.env.DB, "INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", group.id, id, t),
  ]);
  return c.json({ id, name: input.name });
});

groupRoutes.delete("/groups/:id/members/:userId", async (c) => {
  const group = await requireMember(c, c.req.param("id"));
  const me = c.get("user").id;
  const target = c.req.param("userId");
  if (target === group.owner_id) fail(400, "The owner can't leave their own group.");
  if (target !== me) requireOwner(group, me);
  await run(c.env.DB, "DELETE FROM group_members WHERE group_id = ? AND user_id = ?", group.id, target);
  return c.json({ ok: true });
});

/**
 * One-time login link for a member, e.g. for Grandma's phone, or someone who cleared their cookies.
 * Only for accounts without a password, and only if every group they're in belongs to this owner —
 * otherwise an owner could take over someone's account.
 */
groupRoutes.post("/groups/:id/members/:userId/login-link", async (c) => {
  const group = await requireMember(c, c.req.param("id"));
  const me = c.get("user").id;
  requireOwner(group, me);
  const target = await first<{ id: string; password_hash: string | null; other_groups: number }>(
    c.env.DB,
    `SELECT u.id, u.password_hash,
            (SELECT COUNT(*) FROM group_members m JOIN split_groups g ON g.id = m.group_id
              WHERE m.user_id = u.id AND g.owner_id <> ?) AS other_groups
       FROM users u JOIN group_members gm ON gm.user_id = u.id AND gm.group_id = ?
      WHERE u.id = ?`,
    me,
    group.id,
    c.req.param("userId"),
  );
  if (!target) fail(404, "That person isn't in this group.");
  if (target.password_hash) fail(403, "They have a password, so they need to log in themselves.");
  if (target.other_groups > 0) fail(403, "They're also in someone else's group, so only they can make a login link.");
  return c.json(await createLoginLink(c, target.id, me, OWNER_LINK_TTL));
});
