import { randomUUID } from "node:crypto";
import { resolveContainerBuildIdentity } from "./container-build-identity";

type CommandResult = { stdout: string; stderr: string };

function run(command: string[], options: { allowFailure?: boolean } = {}): CommandResult {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${command.join(" ")} failed (${result.exitCode})\n${stderr || stdout}`);
  }
  return { stdout, stderr };
}

function publishedBaseUrl(container: string): string {
  const address = run(["docker", "port", container, "4319/tcp"]).stdout.trim();
  if (!/^127\.0\.0\.1:[0-9]+$/.test(address)) {
    throw new Error(`container port must be published on host loopback, got: ${address}`);
  }
  return `http://${address}`;
}

async function waitForPublishedReadiness(container: string, baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/ready`);
      const body = await response.json();
      const healthResponse = await fetch(`${baseUrl}/api/health`);
      const health = await healthResponse.json();
      if (
        response.status === 200 &&
        body?.ok === true &&
        body?.checks?.workspaceControl === "ok" &&
        body?.checks?.companyLedgers === "ok" &&
        healthResponse.status === 200 &&
        health?.deploymentProfile === "local-container"
      ) return;
    } catch {
      // The process may still be starting; retry within the bounded window.
    }
    await Bun.sleep(100);
  }
  const logs = run(["docker", "logs", container], { allowFailure: true });
  throw new Error(`published container did not become ready at ${baseUrl}\n${logs.stderr}${logs.stdout}`);
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const image = `rentemester-integration:${suffix}`;
const volume = `rentemester-integration-${suffix}`;
const first = `rentemester-first-${suffix}`;
const second = `rentemester-second-${suffix}`;
const identity = resolveContainerBuildIdentity();

try {
  run([
    "docker", "build", "--provenance=false", "--tag", image,
    "--build-arg", `RENTEMESTER_VERSION=${identity.version}`,
    "--build-arg", `RENTEMESTER_GIT_COMMIT=${identity.commit}`,
    "--build-arg", `RENTEMESTER_BUILT_AT=${identity.builtAt}`,
    "--build-arg", `RENTEMESTER_BUN_VERSION=${identity.bunVersion}`,
    "--build-arg", `RENTEMESTER_BASE_IMAGE_DIGEST=${identity.baseImageDigest}`,
    "--build-arg", `SOURCE_DATE_EPOCH=${identity.sourceDateEpoch}`,
    ".",
  ]);
  const documentExample = JSON.parse(
    run(["docker", "run", "--rm", "--read-only", image, "documents", "ingest", "--example"]).stdout,
  );
  if (
    documentExample?.source !== "email" ||
    documentExample?.currency !== "DKK" ||
    typeof documentExample?.amountIncVat !== "number"
  ) throw new Error("documents ingest --example must emit valid metadata JSON");
  run(["docker", "volume", "create", volume]);

  run([
    "docker", "run", "--detach", "--name", first, "--read-only",
    "--publish", "127.0.0.1::4319",
    "--env", "RENTEMESTER_DEPLOYMENT_PROFILE=local-container",
    "--env", "RENTEMESTER_APP_AUTH=off",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs", "/import:rw,nosuid,size=64m",
    "--volume", `${volume}:/workspace`, image,
  ]);
  const firstBaseUrl = publishedBaseUrl(first);
  await waitForPublishedReadiness(first, firstBaseUrl);
  if (run(["docker", "exec", first, "id", "-u"]).stdout.trim() !== "1000") {
    throw new Error("container must run as uid 1000");
  }
  const emptyCompaniesResponse = await fetch(`${firstBaseUrl}/api/companies`);
  const emptyCompaniesBody = await emptyCompaniesResponse.json();
  if (!emptyCompaniesResponse.ok || emptyCompaniesBody?.companies?.length !== 0) {
    throw new Error(`fresh volume must start with zero companies: ${JSON.stringify(emptyCompaniesBody)}`);
  }
  const createResponse = await fetch(`${firstBaseUrl}/api/companies`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: firstBaseUrl },
    body: JSON.stringify({ name: "Container Example ApS" }),
  });
  const createBody = await createResponse.json();
  if (!createResponse.ok || createBody?.company?.slug !== "container-example-aps") {
    throw new Error(`first company creation failed: ${JSON.stringify(createBody)}`);
  }
  run(["docker", "rm", "--force", first]);

  run([
    "docker", "run", "--detach", "--name", second, "--read-only",
    "--publish", "127.0.0.1::4319",
    "--env", "RENTEMESTER_DEPLOYMENT_PROFILE=local-container",
    "--env", "RENTEMESTER_APP_AUTH=off",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs", "/import:rw,nosuid,size=64m",
    "--volume", `${volume}:/workspace`, image,
  ]);
  const baseUrl = publishedBaseUrl(second);
  await waitForPublishedReadiness(second, baseUrl);
  const companiesResponse = await fetch(`${baseUrl}/api/companies`);
  const companiesBody = await companiesResponse.json();
  if (
    !companiesResponse.ok ||
    companiesBody?.companies?.length !== 1 ||
    companiesBody.companies[0]?.slug !== "container-example-aps"
  ) throw new Error(JSON.stringify(companiesBody));
  console.log("container integration passed: CLI example, fresh-volume readiness, API create, default command, persisted restart, non-root");
} finally {
  run(["docker", "rm", "--force", first], { allowFailure: true });
  run(["docker", "rm", "--force", second], { allowFailure: true });
  run(["docker", "volume", "rm", "--force", volume], { allowFailure: true });
  run(["docker", "image", "rm", "--force", image], { allowFailure: true });
}
