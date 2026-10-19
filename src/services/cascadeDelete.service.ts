import { Prisma } from '@prisma/client';

/**
 * Deletes rows AND everything that depends on them, by following the foreign
 * keys declared in the Prisma schema. This replaces hand-written lists of
 * "delete this table, then that table", which silently go stale every time a
 * new table that points at a wing/flat/user is added (that is how deleting a
 * society started failing on the Amenity table).
 *
 *  - required link  (e.g. Amenity.wingId)  → the child rows are deleted first
 *  - optional link  (e.g. User.societyId)  → the link is cleared, rows are kept
 */

type Model = { name: string; fields: Array<{
  name: string; kind: string; type: string;
  relationName?: string; relationFromFields?: string[]; relationToFields?: string[]; isRequired: boolean;
}> };

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export interface CascadeOptions {
  /** Test hook: use a different schema description than the real one. */
  models?: Model[];
}

export async function cascadeDelete(
  db: any,
  modelName: string,
  ids: string[],
  opts: CascadeOptions = {},
): Promise<void> {
  const models: Model[] = opts.models ?? (Prisma.dmmf.datamodel.models as unknown as Model[]);
  const done = new Set<string>(); // "Model:id" — protects against cycles and repeat work

  async function remove(model: string, wanted: string[]): Promise<void> {
    const todo = wanted.filter((id) => !done.has(`${model}:${id}`));
    if (todo.length === 0) return;
    todo.forEach((id) => done.add(`${model}:${id}`));

    for (const child of models) {
      for (const f of child.fields) {
        if (f.kind !== 'object' || f.type !== model) continue;
        const fk = f.relationFromFields?.[0];
        if (!fk || f.relationToFields?.[0] !== 'id') continue; // not a link held by `child`
        const delegate = db[lower(child.name)];

        if (f.isRequired) {
          const rows: Array<{ id: string }> = await delegate.findMany({ where: { [fk]: { in: todo } }, select: { id: true } });
          await remove(child.name, rows.map((r) => r.id));
        } else {
          await delegate.updateMany({ where: { [fk]: { in: todo } }, data: { [fk]: null } });
        }
      }
    }
    await db[lower(model)].deleteMany({ where: { id: { in: todo } } });
  }

  await remove(modelName, ids);
}
