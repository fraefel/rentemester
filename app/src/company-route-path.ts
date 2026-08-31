/** Pure company-route URL matching shared by the registry and navigation UI. */
export type CompanyRoutePathDescriptor = {
  segment: string;
};

export function companyRouteForPath<Route extends CompanyRoutePathDescriptor>(
  pathname: string,
  routes: readonly Route[],
): Route | undefined {
  if (pathname === "/companies/new" || pathname.startsWith("/companies/new/")) return undefined;
  const match = pathname.match(/^\/companies\/[^/]+\/?(.*)$/);
  if (!match) return undefined;
  const segment = match[1].replace(/\/$/, "");
  return routes.find((route) => route.segment === segment);
}
