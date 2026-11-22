"use server";

import { checked, field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { createPolicy, rollbackPolicy, updatePolicy } from "@/lib/nepa/policies";

export async function savePolicyAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const input = {
    title: field(f, "title"), ruleText: field(f, "ruleText"), mandatory: checked(f, "mandatory"), active: checked(f, "active"),
    effectiveFrom: field(f, "effectiveFrom") || undefined, effectiveTo: field(f, "effectiveTo") || null, note: field(f, "note"),
  };
  if (id) return finish(await updatePolicy(user, id, input), { redirect: `/admin/policies/${id}?ok=saved`, revalidate: ["/admin/policies"] });
  return finish(await createPolicy(user, { ...input, key: field(f, "key"), category: field(f, "category") }), { redirect: (v) => `/admin/policies/${v}?ok=saved`, revalidate: ["/admin/policies"] });
}

export async function rollbackPolicyAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  return finish(await rollbackPolicy(user, id, field(f, "versionId")), { redirect: `/admin/policies/${id}?ok=restored`, revalidate: ["/admin/policies"] });
}
