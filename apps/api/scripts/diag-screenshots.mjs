import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const counts = await prisma.screenshot.groupBy({
  by: ['status'],
  _count: { _all: true },
});

console.log('Status counts:');
for (const c of counts) console.log(`  ${c.status}: ${c._count._all}`);

const recent = await prisma.screenshot.findMany({
  orderBy: { createdAt: 'desc' },
  take: 10,
  select: {
    id: true,
    status: true,
    capturedAt: true,
    s3Key: true,
    thumbnailS3Key: true,
    sizeBytes: true,
    createdAt: true,
  },
});

console.log('\nLast 10 rows:');
for (const r of recent) {
  console.log(
    `  ${r.id}  status=${r.status}  size=${r.sizeBytes ?? 'null'}  thumb=${r.thumbnailS3Key ? 'yes' : 'no'}  captured=${r.capturedAt.toISOString()}`,
  );
}

const byProject = await prisma.screenshot.findMany({
  where: { deletedAt: null },
  include: { timeEntry: { include: { project: { select: { name: true } } } } },
});

const grouped = {};
for (const s of byProject) {
  const key = `${s.timeEntry.project.name}::${s.status}::thumb=${s.thumbnailS3Key ? 'yes' : 'no'}`;
  grouped[key] = (grouped[key] ?? 0) + 1;
}
console.log('\nBy project / status / thumb:');
for (const [k, v] of Object.entries(grouped)) console.log(`  ${k}: ${v}`);

await prisma.$disconnect();
