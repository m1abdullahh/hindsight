import type { Device, User } from '@prisma/client';

import { writeAudit } from '../../auth/audit.js';
import { mintToken } from '../../auth/tokens.js';
import { AppError } from '../../lib/errors.js';
import { ulid } from '../../lib/id.js';
import { prisma } from '../../lib/prisma.js';
import { toDeviceDto, type DeviceDto } from '../../lib/dto.js';

import type { HeartbeatInput, RegisterDeviceInput } from './schemas.js';

interface CallerContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface RegisterDeviceResult {
  device: DeviceDto;
  deviceId: string;
  deviceToken: string;
}

const firstActiveOrgId = async (userId: string): Promise<string | null> => {
  const m = await prisma.membership.findFirst({
    where: { userId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  return m?.orgId ?? null;
};

export const registerDevice = async (
  user: User,
  input: RegisterDeviceInput,
  ctx: CallerContext = {},
): Promise<RegisterDeviceResult> => {
  const result = await prisma.$transaction(async (tx) => {
    const device = await tx.device.create({
      data: {
        id: ulid(),
        userId: user.id,
        deviceName: input.deviceName,
        os: input.os,
        appVersion: input.appVersion,
      },
    });

    const orgId = await firstActiveOrgId(user.id);
    if (orgId) {
      await writeAudit(tx, {
        orgId,
        actorId: user.id,
        action: 'device.registered',
        targetType: 'device',
        targetId: device.id,
      });
    }
    return device;
  });

  const minted = await mintToken({
    userId: user.id,
    kind: 'device',
    deviceId: result.id,
    ...(ctx.ipAddress ? { ipAddress: ctx.ipAddress } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  });

  return {
    device: toDeviceDto(result),
    deviceId: result.id,
    deviceToken: minted.plaintext,
  };
};

export const listDevices = async (userId: string): Promise<DeviceDto[]> => {
  const rows = await prisma.device.findMany({
    where: { userId, revokedAt: null },
    orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.map(toDeviceDto);
};

export const revokeDevice = async (caller: User, deviceId: string): Promise<void> => {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new AppError('not_found', 404, 'device not found');

  if (device.userId !== caller.id) {
    // Cross-user revocation requires the caller to be an admin/owner in
    // an org the device's owner belongs to.
    const sharedAdminMembership = await prisma.membership.findFirst({
      where: {
        userId: caller.id,
        status: 'active',
        role: { in: ['owner', 'admin'] },
        organization: {
          memberships: {
            some: { userId: device.userId, status: 'active' },
          },
        },
      },
    });
    if (!sharedAdminMembership) {
      throw new AppError('forbidden', 403, 'cannot revoke this device');
    }
  }

  if (device.revokedAt) {
    throw new AppError('conflict', 409, 'device already revoked');
  }

  const orgId = await firstActiveOrgId(device.userId);

  await prisma.$transaction(async (tx) => {
    await tx.device.update({
      where: { id: device.id },
      data: { revokedAt: new Date() },
    });
    // Revoke the active device token if any.
    const token = await tx.token.findUnique({ where: { deviceId: device.id } });
    if (token && !token.revokedAt) {
      await tx.token.update({
        where: { id: token.id },
        data: { revokedAt: new Date() },
      });
    }
    if (orgId) {
      await writeAudit(tx, {
        orgId,
        actorId: caller.id,
        action: 'device.revoked',
        targetType: 'device',
        targetId: device.id,
      });
    }
  });
};

// Avoid touching the token's lastUsedAt slide; use a direct update instead.
// The slide is debounced for web tokens specifically; heartbeats from device
// tokens hit this code path explicitly.
export const heartbeat = async (device: Device, input: HeartbeatInput): Promise<DeviceDto> => {
  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      lastSeenAt: new Date(),
      ...(input.appVersion !== device.appVersion ? { appVersion: input.appVersion } : {}),
      ...(input.state !== undefined ? { presenceState: input.state } : {}),
    },
  });
  return toDeviceDto(updated);
};
