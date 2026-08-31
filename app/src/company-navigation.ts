/**
 * Compatibility facade for navigation-focused imports. The route registry is
 * the source of truth; this module deliberately owns no route metadata.
 */
export {
  COMPANY_ROUTE_REGISTRY,
  COMPANY_TASK_AREAS,
  assertCompanyRouteRegistry,
  companyRouteForPath,
  companyRoutePattern,
  type CompanyRouteDefinition,
  type CompanyRouteId,
  type CompanyTaskAreaId,
} from "./company-route-registry";

/** @deprecated Use COMPANY_ROUTE_REGISTRY for route descriptors and elements. */
export { COMPANY_ROUTE_REGISTRY as COMPANY_ROUTE_DEFINITIONS } from "./company-route-registry";
