// One-off: for closed time entries with totalActiveSeconds=0, fill it from
// endedAt - startedAt. Safe to re-run; only touches rows that are still 0.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const candidates = await prisma.timeEntry.findMany({
  where: { endedAt: { not: null }, totalActiveSeconds: 0 },
  select: { id: true, startedAt: true, endedAt: true },
});

console.log(`Found ${candidates.length} closed entries with totalActiveSeconds=0`);

let updated = 0;
for (const e of candidates) {
  if (!e.endedAt) continue;
  const seconds = Math.min(
    86_400,
    Math.max(0, Math.floor((e.endedAt.getTime() - e.startedAt.getTime()) / 1000)),
  );
  if (seconds === 0) continue;
  await prisma.timeEntry.update({
    where: { id: e.id },
    data: { totalActiveSeconds: seconds },
  });
  updated += 1;
}

console.log(`Updated ${updated} entries`);
await prisma.$disconnect();
