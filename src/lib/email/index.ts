// Email adapter. No email provider is selected yet (DECISIONS D2), so only the simulated adapter exists.
// A real provider is added by implementing EmailAdapter and selecting it in getEmailAdapter().

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailAdapter {
  readonly name: string;
  readonly simulated: boolean;
  send(message: EmailMessage): Promise<void>;
}

/** Keeps messages in memory and prints them to the server log. Nothing is actually sent. */
export class SimulatedEmailAdapter implements EmailAdapter {
  readonly name = "simulated";
  readonly simulated = true;
  readonly outbox: (EmailMessage & { at: Date })[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.outbox.push({ ...message, at: new Date() });
    if (process.env.APP_ENV === "test") return;
    if (process.env.APP_ENV === "production" || process.env.APP_ENV === "staging") {
      // never write sign-in links into production logs
      console.warn(`[email:NOT SENT] no email provider configured; to=${message.to.replace(/^(.).*(@.*)$/, "$1***$2")} subject="${message.subject}"`);
      return;
    }
    console.info(`[email:SIMULATED] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }
}

let adapter: EmailAdapter | undefined;

export function getEmailAdapter(): EmailAdapter {
  adapter ??= new SimulatedEmailAdapter();
  return adapter;
}

/** Tests only. */
export function setEmailAdapter(a: EmailAdapter): void {
  adapter = a;
}
