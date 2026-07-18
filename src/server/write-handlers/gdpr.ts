// GDPR export + erasure handlers (#334).

import { buildGdprSubjectExport, eraseGdprSubject } from "../../core/gdpr";
import { getCompanySettings } from "../../core/company";
import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { withCompanyMutation } from "../mutations";
import { okResponse, optionalBodyString } from "./_shared";

/**
 * POST /api/companies/:slug/gdpr/export — actor-attributed GDPR insight.
 *
 * The export appends an immutable audit event, so it must not be a GET. The
 * POST path also keeps the subject's PII out of URLs, browser history and
 * access logs.
 */
export async function handleGdprExport(
  config: ServerConfig,
  request: Request,
  slug: string,
): Promise<Response> {
  const result = await withCompanyMutation(
    request,
    config,
    slug,
    (ctx, body) => {
      const cvr = optionalBodyString(body, "cvr");
      const name = optionalBodyString(body, "name");
      const asOf = optionalBodyString(body, "asOf");
      if (!cvr && !name) {
        throw ApiError.badRequest(
          "cvr eller name skal sættes — én af dem identificerer subject'et.",
        );
      }
      const exportResult = buildGdprSubjectExport(
        ctx.db,
        { cvr, name, asOf },
        {
          createdBy: ctx.actor.createdBy,
          createdByProgram: ctx.actor.createdByProgram,
        },
      );
      const company = getCompanySettings(ctx.db);
      return {
        ...exportResult,
        view: {
          slug,
          company: {
            name: company.name,
            cvr: company.cvr,
            country: company.country,
            currency: company.currency,
          },
          export: exportResult,
        },
      };
    },
    { requireConfirm: true },
  );
  return okResponse({ gdpr: result.view });
}

/**
 * POST /api/companies/:slug/gdpr/erase — GDPR-anonymisering (#334).
 *
 * Body: `{ cvr?, name?, confirm:true }`. Wrapper omkring `eraseGdprSubject` fra
 * kernen — den skriver append-only tombstones, men afviser rækker der
 * stadig er under bogføringspligt (5-års retention).
 */
export async function handleGdprErase(
  config: ServerConfig,
  request: Request,
  slug: string,
): Promise<Response> {
  const result = await withCompanyMutation(
    request,
    config,
    slug,
    (ctx, body) => {
      const cvr = optionalBodyString(body, "cvr");
      const name = optionalBodyString(body, "name");
      if (!cvr && !name) {
        throw ApiError.badRequest(
          "cvr eller name skal sættes — én af dem identificerer subject'et.",
        );
      }
      if (body.asOf !== undefined) {
        throw ApiError.badRequest(
          "gdpr erase accepterer ikke asOf; retention vurderes altid mod dags dato",
        );
      }
      return eraseGdprSubject(
        ctx.db,
        { cvr, name },
        {
          createdBy: ctx.actor.createdBy,
          createdByProgram: ctx.actor.createdByProgram,
        },
      );
    },
    { requireConfirm: true },
  );
  return okResponse({ gdprErasure: result });
}
