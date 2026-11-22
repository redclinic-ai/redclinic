"use server";

import { field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { savePhoneSetup } from "@/lib/phone/service";

export async function savePhoneAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  return finish(await savePhoneSetup(user, { clinicNumber: field(f, "clinicNumber"), fallbackNumber: field(f, "fallbackNumber"), forwardingMode: field(f, "forwardingMode") }), { message: "Saved.", revalidate: ["/settings/phone", "/home"] });
}
