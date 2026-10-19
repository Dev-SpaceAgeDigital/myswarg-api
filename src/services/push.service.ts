import { prisma } from '../config/db';

/**
 * Phone alerts (push notifications), sent through Expo's push service, which
 * forwards to Google Firebase (FCM) for Android. Every in-app notification in
 * notification.service.ts also calls pushToUsers(), so a person sees a banner
 * on their phone even when the app is closed.
 *
 * A failure here must never break the action that triggered it (approving a
 * visitor, posting a notice...), so everything is caught and logged.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100;

export function isExpoPushToken(t: unknown): t is string {
  return typeof t === 'string' && /^(Exponent|Expo)PushToken\[[^\]]+\]$/.test(t);
}

export interface PushPayload {
  title: string;
  body?: string;
  type: string;
  relatedId?: string;
}

export async function pushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  try {
    const ids = Array.from(new Set(userIds.filter(Boolean)));
    if (!ids.length) return;

    const users = await prisma.user.findMany({
      where: { id: { in: ids }, isActive: true, pushToken: { not: null } },
      select: { id: true, pushToken: true },
    });
    const targets = users.filter((u) => isExpoPushToken(u.pushToken));
    if (!targets.length) return;

    for (let i = 0; i < targets.length; i += CHUNK) {
      const batch = targets.slice(i, i + CHUNK);
      const messages = batch.map((u) => ({
        to: u.pushToken as string,
        title: payload.title,
        body: payload.body ?? '',
        sound: 'default',
        priority: 'high',
        channelId: 'default',
        data: { type: payload.type, relatedId: payload.relatedId ?? null },
      }));

      const res = await (globalThis as any).fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        console.error('[push] Expo push service returned', res.status);
        continue;
      }
      const json: any = await res.json();
      const tickets: any[] = Array.isArray(json?.data) ? json.data : [];

      // A phone that uninstalled the app (or turned alerts off for good) reports
      // DeviceNotRegistered: forget its token so we stop sending to it.
      const dead: string[] = [];
      tickets.forEach((t, idx) => {
        if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') dead.push(batch[idx].id);
        else if (t?.status === 'error') console.error('[push] ticket error:', t?.message);
      });
      if (dead.length) {
        await prisma.user.updateMany({ where: { id: { in: dead } }, data: { pushToken: null } });
      }
    }
  } catch (err: any) {
    console.error('[push] failed:', err?.message ?? err);
  }
}
