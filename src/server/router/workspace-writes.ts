// Workspace-level write handlers: POST /api/companies (create) and
// PATCH /api/companies/:slug (rename/archive). These do NOT use
// withCompanyMutation because they operate on the workspace registry, not
// on a company's ledger — there is no ledger to back up here.

import { createCompany } from "../../core/company";
import {
  findWorkspaceCompany,
  renameWorkspaceCompany,
  setWorkspaceCompanyArchived,
} from "../../core/workspace";
import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import {
  assertLocalhostWriteAllowed,
  assertMutationContentType,
  assertMutationOriginAllowed,
} from "../mutations";
import { okResponse, optionalString, readJsonBody, requireString } from "./_shared";

/**
 * CSRF/DNS-rebinding-hærdning (audit 2026-06-11, SEC-1-BYPASS) for de
 * workspace-niveau skriveruter. Disse handlers går IKKE gennem
 * `withCompanyMutation` (der er ingen company-ledger at åbne/backup-låse her),
 * så de inheritede ikke gates som dækker company-ruterne. Vi anvender derfor de
 * SAMME tre gates direkte — uafhængigt af en db — FØR body læses:
 *
 *   1. Content-Type-gate (INVALID_CONTENT_TYPE) — lukker text/plain simple-
 *      request-vektoren;
 *   2. Origin-gate (FORBIDDEN_ORIGIN) — kræver loopback-origin når en browser
 *      sender en;
 *   3. localhost-gate — afviser ikke-loopback Host uden auth.
 *
 * Origin- og localhost-gaten træder til side når `authRequired` er sat — dér er
 * bearer-tokenet gaten — konsistent med `withCompanyMutation`.
 */
function assertWorkspaceWriteAllowed(request: Request, config: ServerConfig): void {
  assertLocalhostWriteAllowed(request, config);
  assertMutationOriginAllowed(request, config);
  assertMutationContentType(request);
}

/**
 * Parses the optional `payment` body field on the create-company form (#284)
 * into a core `CompanyPaymentInput`. Every sub-field is optional — `createCompany`
 * only creates the primary bank account when at least one carries information.
 */
/**
 * Parses the optional `vatPeriodType` create-company field, preserving the
 * NOT-VAT-registered signal that `optionalString` would otherwise drop:
 * a JSON `null` or the string `"none"` both mean "not registered" (→ `null`,
 * which `initialiseCompanyVolume` writes verbatim); a cadence string passes
 * through; absent stays `undefined` (historical quarterly default).
 */
function parseCreateVatPeriod(body: Record<string, unknown>): string | null | undefined {
  const raw = body.vatPeriodType;
  if (raw === null) return null;
  if (typeof raw === "string") {
    const v = raw.trim();
    if (v === "none") return null;
    return v.length > 0 ? v : undefined;
  }
  return undefined;
}

function parseCreatePayment(
  body: Record<string, unknown>,
): { bankName?: string; registrationNo?: string; accountNo?: string; iban?: string } | undefined {
  const raw = body.payment;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw ApiError.badRequest("'payment' must be an object when present");
  }
  const p = raw as Record<string, unknown>;
  const payment: {
    bankName?: string;
    registrationNo?: string;
    accountNo?: string;
    iban?: string;
  } = {};
  for (const field of ["bankName", "registrationNo", "accountNo", "iban"] as const) {
    const value = optionalString(p, field);
    if (value !== undefined) payment[field] = value;
  }
  return Object.keys(payment).length > 0 ? payment : undefined;
}

export async function handleCompanyCreate(
  config: ServerConfig,
  request: Request,
): Promise<Response> {
  assertWorkspaceWriteAllowed(request, config);
  const body = await readJsonBody(request);
  const name = requireString(body, "name");
  const payment = parseCreatePayment(body);
  let result: ReturnType<typeof createCompany>;
  try {
    result = createCompany(config.workspaceRoot, {
      name,
      slug: optionalString(body, "slug"),
      cvr: optionalString(body, "cvr") ?? null,
      fiscalYearStartMonth: optionalString(body, "fiscalYearStartMonth"),
      fiscalYearLabelStrategy: optionalString(body, "fiscalYearLabelStrategy"),
      // #300: the VAT settlement cadence — or `null`/"none" for a NOT
      // VAT-registered company. `initialiseCompanyVolume` validates it and
      // throws on an unknown value — re-mapped to a 400 below.
      vatPeriodType: parseCreateVatPeriod(body),
      ...(payment ? { payment } : {}),
    });
  } catch (err) {
    // createCompany throws plain Errors for invalid slug / duplicate. Re-map
    // them to a safe code; the messages it produces are curated (no paths)
    // — except `companyRoot`, which createCompany only embeds for the
    // "already exists" case, so collapse that to a generic conflict.
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists|already registered/i.test(message)) {
      throw ApiError.conflict("der findes allerede en virksomhed med den slug");
    }
    throw ApiError.badRequest(message);
  }
  return okResponse(
    {
      company: { slug: result.slug, name: result.name },
    },
    201,
  );
}

/**
 * Updates a registered company's mutable workspace metadata: the display
 * `name` and/or the `archived` flag. This never touches the slug or the
 * ledger — there is deliberately NO destructive delete of ledger data.
 */
export async function handleCompanyUpdate(
  config: ServerConfig,
  slug: string,
  request: Request,
): Promise<Response> {
  assertWorkspaceWriteAllowed(request, config);
  if (!findWorkspaceCompany(config.workspaceRoot, slug)) {
    throw ApiError.notFound(`ingen virksomhed med slug '${slug}' findes i workspacet`);
  }
  const body = await readJsonBody(request);
  const name = optionalString(body, "name");
  const archivedRaw = body.archived;
  if (archivedRaw !== undefined && typeof archivedRaw !== "boolean") {
    throw ApiError.badRequest("'archived' must be a boolean when present");
  }
  if (name === undefined && archivedRaw === undefined) {
    throw ApiError.badRequest("angiv 'name' og/eller 'archived' for at opdatere");
  }
  try {
    let entry = findWorkspaceCompany(config.workspaceRoot, slug)!;
    if (name !== undefined) {
      entry = renameWorkspaceCompany(config.workspaceRoot, slug, name);
    }
    if (typeof archivedRaw === "boolean") {
      entry = setWorkspaceCompanyArchived(config.workspaceRoot, slug, archivedRaw);
    }
    return okResponse({
      company: {
        slug: entry.slug,
        name: entry.name,
        createdAt: entry.createdAt,
        archived: entry.archived,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw ApiError.badRequest(message);
  }
}
