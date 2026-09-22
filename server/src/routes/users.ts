import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, type AuthedRequest } from "../auth";

const router = Router();

router.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ id: user.id, username: user.username, email: user.email, avatarColor: user.avatarColor, status: user.status });
});

router.get("/search", requireAuth, async (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json({ users: [] });
  const users = await prisma.user.findMany({
    where: { username: { contains: q }, NOT: { id: req.userId! } },
    take: 10,
    select: { id: true, username: true, avatarColor: true, status: true },
  });
  res.json({ users });
});

export default router;
