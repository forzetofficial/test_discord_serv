import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../db";
import { requireAuth, type AuthedRequest } from "../auth";

const router = Router();

function makeInviteCode() {
  return crypto.randomBytes(4).toString("hex");
}

async function assertMember(userId: string, serverId: string) {
  const membership = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId, serverId } },
  });
  return !!membership;
}

router.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const servers = await prisma.server.findMany({
    where: { members: { some: { userId: req.userId! } } },
    include: { channels: { orderBy: { position: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
  res.json({ servers });
});

router.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const { name } = req.body ?? {};
  if (!name || String(name).trim().length === 0) {
    return res.status(400).json({ error: "Server name is required" });
  }

  const server = await prisma.server.create({
    data: {
      name: String(name).trim(),
      ownerId: req.userId!,
      inviteCode: makeInviteCode(),
      members: { create: { userId: req.userId! } },
      channels: {
        create: [
          { name: "general", type: "text", position: 0 },
          { name: "General", type: "voice", position: 1 },
        ],
      },
    },
    include: { channels: true },
  });

  res.status(201).json({ server });
});

router.post("/join", requireAuth, async (req: AuthedRequest, res) => {
  const { inviteCode } = req.body ?? {};
  if (!inviteCode) return res.status(400).json({ error: "inviteCode is required" });

  const server = await prisma.server.findUnique({ where: { inviteCode: String(inviteCode).trim() } });
  if (!server) return res.status(404).json({ error: "Invalid invite code" });

  const already = await assertMember(req.userId!, server.id);
  if (!already) {
    await prisma.serverMember.create({ data: { userId: req.userId!, serverId: server.id } });
  }

  const full = await prisma.server.findUnique({
    where: { id: server.id },
    include: { channels: { orderBy: { position: "asc" } } },
  });
  res.json({ server: full });
});

router.get("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const isMember = await assertMember(req.userId!, req.params.id);
  if (!isMember) return res.status(403).json({ error: "Not a member of this server" });

  const server = await prisma.server.findUnique({
    where: { id: req.params.id },
    include: {
      channels: { orderBy: { position: "asc" } },
      members: { include: { user: { select: { id: true, username: true, avatarColor: true, status: true } } } },
    },
  });
  if (!server) return res.status(404).json({ error: "Not found" });
  res.json({ server });
});

router.post("/:id/channels", requireAuth, async (req: AuthedRequest, res) => {
  const isMember = await assertMember(req.userId!, req.params.id);
  if (!isMember) return res.status(403).json({ error: "Not a member of this server" });

  const { name, type } = req.body ?? {};
  if (!name || !["text", "voice"].includes(type)) {
    return res.status(400).json({ error: "name and type ('text'|'voice') are required" });
  }

  const count = await prisma.channel.count({ where: { serverId: req.params.id } });
  const channel = await prisma.channel.create({
    data: { serverId: req.params.id, name: String(name).trim(), type, position: count },
  });
  res.status(201).json({ channel });
});

export default router;
