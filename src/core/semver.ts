// Official SemVer 2.0.0 grammar, expressed without global state so it is safe
// to reuse in long-running processes and release scripts.
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}
