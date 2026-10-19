import { prisma } from '../config/db';
import { pushToUsers } from './push.service';

// Central place to fire in-app notifications whenever an approval-type
// action happens (visitor approved/denied, booking approved/rejected,
// emergency alert resolved, resale listing approved/rejected, complaint
// resolved). Errors are swallowed so a notification failure never blocks
// the actual approval action itself.

export async function notifyUser(params: {
  userId: string;
  title: string;
  body?: string;
  type: string;
  relatedId?: string;
}) {
  try {
    await prisma.notification.create({
      data: {
        userId: params.userId,
        title: params.title,
        body: params.body,
        type: params.type,
        relatedId: params.relatedId,
      },
    });
    void pushToUsers([params.userId], params);
  } catch (err) {
    console.error('[notifyUser] Failed to create notification:', err);
  }
}

// Notifies the Wing Secretary (every active WING_ADMIN of the wing) when a
// resident does something the Secretary needs to see: a complaint raised, a
// payment claimed, a listing or booking submitted, an emergency alert, etc.
export async function notifyWingAdmins(params: {
  wingId: string;
  title: string;
  body?: string;
  type: string;
  relatedId?: string;
}) {
  try {
    if (!params.wingId) return;
    const admins = await prisma.user.findMany({
      where: { wingId: params.wingId, role: 'WING_ADMIN', isActive: true },
      select: { id: true },
    });
    if (!admins.length) return;
    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        title: params.title,
        body: params.body,
        type: params.type,
        relatedId: params.relatedId,
      })),
    });
    void pushToUsers(admins.map((a) => a.id), params);
  } catch (err) {
    console.error('[notifyWingAdmins] Failed to create notifications:', err);
  }
}

// Notifies a specific list of users at once (used for notices addressed to a
// whole wing, a floor or a flat).
export async function notifyUsers(params: {
  userIds: string[];
  title: string;
  body?: string;
  type: string;
  relatedId?: string;
}) {
  try {
    if (!params.userIds.length) return;
    await prisma.notification.createMany({
      data: params.userIds.map((userId) => ({
        userId,
        title: params.title,
        body: params.body,
        type: params.type,
        relatedId: params.relatedId,
      })),
    });
    void pushToUsers(params.userIds, params);
  } catch (err) {
    console.error('[notifyUsers] Failed to create notifications:', err);
  }
}

// "Ramesh Shah (Flat A-101)" — short label used in Secretary notifications.
export async function residentLabel(userId: string): Promise<string> {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, flat: { select: { number: true } } },
    });
    if (!u) return 'A resident';
    return u.flat?.number ? `${u.name} (Flat ${u.flat.number})` : u.name;
  } catch {
    return 'A resident';
  }
}

// Notifies every active user (owner/tenant/family) linked to a flat — used
// for events like visitor approval where there's no single "requester"
// user, just a flat the visitor was headed to.
export async function notifyFlat(params: {
  flatId: string;
  title: string;
  body?: string;
  type: string;
  relatedId?: string;
}) {
  try {
    const users = await prisma.user.findMany({
      where: { flatId: params.flatId, isActive: true },
      select: { id: true },
    });
    if (!users.length) return;
    await prisma.notification.createMany({
      data: users.map((u) => ({
        userId: u.id,
        title: params.title,
        body: params.body,
        type: params.type,
        relatedId: params.relatedId,
      })),
    });
    void pushToUsers(users.map((u) => u.id), params);
  } catch (err) {
    console.error('[notifyFlat] Failed to create notifications:', err);
  }
}
