/** Scheduler-facing recurring-invoice runner. It owns no clock or credentials. */
import type { Database } from "bun:sqlite";
import { isValidIsoDate } from "./dates";
import {
  generateRecurringInvoice,
  periodIndexAsOf,
  type RecurringDeliveryChannel,
  type RecurringInterval,
} from "./recurring-invoices";

type DeliveryChannel = Exclude<RecurringDeliveryChannel, "manual">;

export type RecurringDeliveryStatus =
  | "acknowledged"
  | "accepted_pending"
  | "terminal_failed"
  | "uncertain";

export type RecurringDeliveryOutcome = {
  status: RecurringDeliveryStatus;
  message?: string;
  /** Non-secret provider identity retained for status-only observation. */
  providerId?: string;
  /** Status/config/auth check failed; the accepted document remains pending. */
  observationFailed?: boolean;
};

export type RecurringDeliveryAdapter = {
  /** Local validation only. It must never attempt transport. */
  preflight: (input: { documentId: number; channel: DeliveryChannel }) =>
    Promise<{ ok: boolean; error?: string }>;
  /** Crosses the transport boundary exactly once after the DB reservation. */
  deliver: (input: { documentId: number; channel: DeliveryChannel }) =>
    Promise<RecurringDeliveryOutcome>;
  /** Status-only observation for an already accepted provider identity. */
  observePending?: (input: {
    documentId: number;
    channel: DeliveryChannel;
    providerId: string;
  }) => Promise<RecurringDeliveryOutcome>;
};

export type RunRecurringInvoicesInput = {
  companyRoot: string;
  asOfDate: string;
  adapter?: RecurringDeliveryAdapter;
  createdBy?: string;
  createdByProgram?: string;
  /** Hard cap per invocation. A later scheduler call continues remaining gaps. */
  maxGenerations?: number;
};

type TemplateRow = {
  id: number;
  interval: RecurringInterval;
  interval_count: number;
  first_issue_date: string;
  delivery_channel: RecurringDeliveryChannel;
};
type DueTemplate = TemplateRow & { latestPeriodIndex: number; missingCount: number };
type GenerationRow = {
  id: number;
  template_id: number;
  period_index: number;
  document_id: number;
  delivery_channel: DeliveryChannel;
  latest_event: string | null;
  provider_id: string | null;
  latest_message: string | null;
};

const DEFAULT_MAX_GENERATIONS = 500;
const MAX_MAX_GENERATIONS = 5_000;

/** Provider/config errors may reach operator output and append-only state. */
export function sanitizeRecurringDeliveryError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "delivery failed");
  return raw
    .replace(/https?:\/\/\S+/gi, "[url redacted]")
    .replace(/\b(api[_-]?key|authorization|password|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[token redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "delivery failed";
}

function latestPeriod(template: TemplateRow, asOfDate: string): number {
  return periodIndexAsOf(
    template.first_issue_date,
    template.interval === "monthly" ? 1 : template.interval === "quarterly" ? 3 : template.interval === "yearly" ? 12 : 0,
    asOfDate,
    template.interval_count,
    template.interval,
  );
}

/** Finds one indexed gap without materialising 0..latest in JavaScript. */
function nextMissingPeriod(
  db: Database,
  templateId: number,
  fromPeriod: number,
  latest: number,
): number | null {
  if (fromPeriod > latest) return null;
  const row = db.query(
    `SELECT MIN(period_index) AS period_index FROM (
       SELECT ? AS period_index
        WHERE NOT EXISTS (
          SELECT 1 FROM recurring_invoice_generations
           WHERE template_id = ? AND period_index = ?
        )
       UNION ALL
       SELECT g.period_index + 1 AS period_index
         FROM recurring_invoice_generations g
        WHERE g.template_id = ?
          AND g.period_index >= ?
          AND g.period_index < ?
          AND NOT EXISTS (
            SELECT 1 FROM recurring_invoice_generations next
             WHERE next.template_id = g.template_id
               AND next.period_index = g.period_index + 1
          )
     ) WHERE period_index <= ?`,
  ).get(fromPeriod, templateId, fromPeriod, templateId, fromPeriod, latest, latest) as
    { period_index: number | null } | null;
  return row?.period_index ?? null;
}

function appendDeliveryEvent(
  db: Database,
  generationId: number,
  channel: DeliveryChannel,
  eventType: "acknowledged" | "accepted_pending" | "terminal_failed" | "uncertain" | "preflight_failed",
  message: string,
  providerId?: string,
): void {
  db.run(
    `INSERT INTO recurring_invoice_delivery_events
       (generation_id, channel, event_type, provider_id, message)
     VALUES (?, ?, ?, ?, ?)`,
    generationId,
    channel,
    eventType,
    providerId?.trim() || null,
    message,
  );
}

function deliveryCandidates(db: Database, templates: DueTemplate[], limit: number): GenerationRow[] {
  const rows: GenerationRow[] = [];
  for (const template of templates) {
    if (template.delivery_channel === "manual" || template.latestPeriodIndex < 0 || rows.length >= limit) continue;
    const remaining = limit - rows.length;
    rows.push(...db.query(
      `SELECT g.id, g.template_id, g.period_index, g.document_id,
              t.delivery_channel,
              (SELECT e.event_type FROM recurring_invoice_delivery_events e
                WHERE e.generation_id = g.id ORDER BY e.id DESC LIMIT 1) AS latest_event,
              (SELECT e.provider_id FROM recurring_invoice_delivery_events e
                WHERE e.generation_id = g.id ORDER BY e.id DESC LIMIT 1) AS provider_id,
              (SELECT e.message FROM recurring_invoice_delivery_events e
                WHERE e.generation_id = g.id ORDER BY e.id DESC LIMIT 1) AS latest_message
         FROM recurring_invoice_generations g
         JOIN recurring_invoice_templates t ON t.id = g.template_id
        WHERE g.template_id = ? AND g.period_index <= ?
          AND COALESCE((SELECT e.event_type FROM recurring_invoice_delivery_events e
                         WHERE e.generation_id = g.id ORDER BY e.id DESC LIMIT 1), '')
              IN ('', 'preflight_failed', 'attempted', 'accepted_pending', 'terminal_failed', 'uncertain')
        ORDER BY g.period_index
        LIMIT ?`,
    ).all(template.id, template.latestPeriodIndex, remaining) as GenerationRow[]);
  }
  return rows;
}

function outcomeMessage(outcome: RecurringDeliveryOutcome): string {
  return sanitizeRecurringDeliveryError(outcome.message ?? (
    outcome.status === "acknowledged" ? "delivery acknowledged" :
    outcome.status === "accepted_pending" ? "delivery accepted and pending" :
    outcome.status === "terminal_failed" ? "delivery failed after provider acceptance" :
    "delivery outcome uncertain"
  ));
}

export async function runRecurringInvoices(db: Database, input: RunRecurringInvoicesInput) {
  if (!isValidIsoDate(input.asOfDate)) {
    return { ok: false, errors: ["asOfDate must be a YYYY-MM-DD date"], generated: 0, attempted: 0, hasMore: false, remainingGenerations: 0 };
  }
  const maxGenerations = input.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
  if (!Number.isInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > MAX_MAX_GENERATIONS) {
    return { ok: false, errors: [`maxGenerations must be an integer between 1 and ${MAX_MAX_GENERATIONS}`], generated: 0, attempted: 0, hasMore: false, remainingGenerations: 0 };
  }

  const templates = db.query(
    `SELECT id, interval, interval_count, first_issue_date, delivery_channel
       FROM recurring_invoice_templates WHERE active = 1 ORDER BY id`,
  ).all() as TemplateRow[];
  const dueTemplates: DueTemplate[] = templates.map((template) => {
    const latestPeriodIndex = latestPeriod(template, input.asOfDate);
    const existingDue = latestPeriodIndex < 0 ? 0 : (db.query(
      `SELECT COUNT(*) AS count FROM recurring_invoice_generations
        WHERE template_id = ? AND period_index <= ?`,
    ).get(template.id, latestPeriodIndex) as { count: number }).count;
    return { ...template, latestPeriodIndex, missingCount: Math.max(0, latestPeriodIndex + 1 - existingDue) };
  });

  // Plan only the bounded work for this invocation. No array proportional to
  // the template's historical age is ever created.
  const selectedMissing: Array<{ template: DueTemplate; periodIndex: number }> = [];
  for (const template of dueTemplates) {
    let cursor = nextMissingPeriod(db, template.id, 0, template.latestPeriodIndex);
    while (cursor !== null && selectedMissing.length < maxGenerations) {
      selectedMissing.push({ template, periodIndex: cursor });
      if (selectedMissing.length >= maxGenerations) break;
      cursor = nextMissingPeriod(db, template.id, cursor + 1, template.latestPeriodIndex);
    }
    if (selectedMissing.length >= maxGenerations) break;
  }

  let generated = 0;
  let resolvedMissing = 0;
  let attempted = 0;
  const errors: string[] = [];
  for (const item of selectedMissing) {
    const result = generateRecurringInvoice(db, input.companyRoot, {
      templateId: item.template.id,
      asOfDate: input.asOfDate,
      periodIndex: item.periodIndex,
      createdBy: input.createdBy,
      createdByProgram: input.createdByProgram,
    });
    if (!result.ok) {
      errors.push(...result.errors.map(sanitizeRecurringDeliveryError));
      continue;
    }
    resolvedMissing += 1;
    if (result.created) generated += 1;
  }

  for (const generation of deliveryCandidates(db, dueTemplates, maxGenerations)) {
    if (generation.latest_event === "attempted") {
      errors.push(sanitizeRecurringDeliveryError(
        "delivery attempt has no recorded outcome; manual provider reconciliation is required before retry",
      ));
      continue;
    }
    if (generation.latest_event === "terminal_failed" || generation.latest_event === "uncertain") {
      errors.push(sanitizeRecurringDeliveryError(generation.latest_message ?? "delivery requires manual reconciliation"));
      continue;
    }
    if (!input.adapter) {
      const message = "delivery adapter is not configured";
      appendDeliveryEvent(db, generation.id, generation.delivery_channel, "preflight_failed", message);
      errors.push(`template ${generation.template_id} requires a ${generation.delivery_channel} delivery adapter`);
      continue;
    }

    if (generation.latest_event === "accepted_pending") {
      if (!generation.provider_id || !input.adapter.observePending) {
        errors.push("accepted delivery cannot be status-observed with the configured adapter");
        continue;
      }
      try {
        const outcome = await input.adapter.observePending({
          documentId: generation.document_id,
          channel: generation.delivery_channel,
          providerId: generation.provider_id,
        });
        const message = outcomeMessage(outcome);
        appendDeliveryEvent(db, generation.id, generation.delivery_channel, outcome.status, message, outcome.providerId ?? generation.provider_id);
        if (outcome.observationFailed || outcome.status === "terminal_failed" || outcome.status === "uncertain") errors.push(message);
      } catch (error) {
        const message = sanitizeRecurringDeliveryError(error);
        appendDeliveryEvent(db, generation.id, generation.delivery_channel, "accepted_pending", message, generation.provider_id);
        errors.push(message);
      }
      continue;
    }

    let preflight: { ok: boolean; error?: string };
    try {
      preflight = await input.adapter.preflight({ documentId: generation.document_id, channel: generation.delivery_channel });
    } catch (error) {
      preflight = { ok: false, error: sanitizeRecurringDeliveryError(error) };
    }
    if (!preflight.ok) {
      const message = sanitizeRecurringDeliveryError(preflight.error ?? "preflight failed");
      appendDeliveryEvent(db, generation.id, generation.delivery_channel, "preflight_failed", message);
      errors.push(message);
      continue;
    }

    const reserved = db.transaction(() => db.query(
      `INSERT INTO recurring_invoice_delivery_events (generation_id, channel, event_type)
       VALUES (?, ?, 'attempted') ON CONFLICT DO NOTHING`,
    ).run(generation.id, generation.delivery_channel).changes > 0, { immediate: true })();
    if (!reserved) continue;
    attempted += 1;
    try {
      const outcome = await input.adapter.deliver({ documentId: generation.document_id, channel: generation.delivery_channel });
      const message = outcomeMessage(outcome);
      appendDeliveryEvent(db, generation.id, generation.delivery_channel, outcome.status, message, outcome.providerId);
      if (outcome.status === "terminal_failed" || outcome.status === "uncertain") errors.push(message);
    } catch (error) {
      const message = sanitizeRecurringDeliveryError(error);
      appendDeliveryEvent(db, generation.id, generation.delivery_channel, "uncertain", message);
      errors.push(message);
    }
  }

  const initialMissing = dueTemplates.reduce((sum, template) => sum + template.missingCount, 0);
  const remainingGenerations = Math.max(0, initialMissing - resolvedMissing);
  return {
    ok: errors.length === 0,
    errors,
    generated,
    attempted,
    hasMore: remainingGenerations > 0,
    remainingGenerations,
    continuation: remainingGenerations > 0 ? { remainingGenerations } : undefined,
  };
}
