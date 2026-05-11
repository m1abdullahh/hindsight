import { prisma } from '../../src/lib/prisma.js';

// Order matters when foreign keys would otherwise block; tables that other
// tables reference go LAST (TRUNCATE … CASCADE handles it, but listing
// dependents first is clearer about intent).
const TABLES = [
  'audit_logs',
  'tokens',
  'invitations',
  'screenshots',
  'time_entries',
  'project_assignments',
  'projects',
  'memberships',
  'devices',
  'organizations',
  'users',
] as const;

export const truncateAll = async (): Promise<void> => {
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE;`);
};

export const isDbReachable = async (): Promise<boolean> => {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return true;
  } catch {
    return false;
  }
};
