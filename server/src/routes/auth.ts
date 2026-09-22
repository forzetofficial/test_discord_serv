import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { signToken } from "../auth";

const router = Router();

const AVATAR_COLORS = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245", "#3ba55d", "#faa61a"];
function randomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

function publicUser(user: { id: string; username: string; email: string; avatarColor: string; status: string }) {
  return { id: user.id, username: user.username, email: user.email, avatarColor: user.avatarColor, status: user.status };
}

router.post("/register", async (req, res) => {
  const { username, email, password } = req.body ?? {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: "username, email and password are required" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: String(email).toLowerCase() }, { username }] },
  });
  if (existing) {
    return res.status(409).json({ error: "Username or email already taken" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      username,
      email: String(email).toLowerCase(),
      passwordHash,
      avatarColor: randomColor(),
    },
  });

  const token = signToken(user.id);
  res.status(201).json({ token, user: publicUser(user) });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken(user.id);
  res.json({ token, user: publicUser(user) });
});

export default router;
