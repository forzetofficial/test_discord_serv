export interface ReactionRow {
  emoji: string;
  userId: string;
}

export interface GroupedReaction {
  emoji: string;
  userIds: string[];
}

export function groupReactions(rows: ReactionRow[]): GroupedReaction[] {
  const byEmoji = new Map<string, string[]>();
  for (const row of rows) {
    const list = byEmoji.get(row.emoji);
    if (list) list.push(row.userId);
    else byEmoji.set(row.emoji, [row.userId]);
  }
  return Array.from(byEmoji.entries()).map(([emoji, userIds]) => ({ emoji, userIds }));
}
