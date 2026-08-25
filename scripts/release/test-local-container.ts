import { randomUUID } from "node:crypto";
import { SYNTHETIC_PDF_TEXT, syntheticNoTextPdf, syntheticTextPdf } from "../../tests/fixtures/pdf-parser/synthetic-text-pdf";
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

async function api(container: string, path: string, body?: unknown): Promise<any> {
  const source = `const r=await fetch("http://127.0.0.1:4319${path}",{method:${JSON.stringify(body === undefined ? "GET" : "POST")},headers:{origin:"http://127.0.0.1:4319","content-type":"application/json"},${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))}`}});const value=await r.json();if(!r.ok)throw new Error(JSON.stringify(value));console.log(JSON.stringify(value));`;
  return JSON.parse(run(["docker", "exec", container, "bun", "-e", source]).stdout);
}

function setLegacyDocumentPath(container: string, slug: string, documentId: number): string {
  const dbPath = `/workspace/${slug}/data/ledger.sqlite`;
  const source = `import {Database} from "bun:sqlite";const db=new Database(${JSON.stringify(dbPath)});const row=db.query("SELECT stored_path FROM documents WHERE id=?").get(${documentId});const name=String(row.stored_path).replaceAll("\\\\","/").split("/").at(-1);const historical="/legacy-host/company/documents/originals/"+name;db.query("UPDATE documents SET stored_path=? WHERE id=?").run(historical,${documentId});db.close();console.log(historical);`;
  return run(["docker", "exec", container, "bun", "-e", source]).stdout.trim();
}

function registeredDocumentPath(container: string, slug: string, documentId: number): string {
  const dbPath = `/workspace/${slug}/data/ledger.sqlite`;
  const source = `import {Database} from "bun:sqlite";const db=new Database(${JSON.stringify(dbPath)},{readonly:true});const row=db.query("SELECT stored_path FROM documents WHERE id=?").get(${documentId});db.close();console.log(row.stored_path);`;
  return run(["docker", "exec", container, "bun", "-e", source]).stdout.trim();
}

function syntheticMetadata(invoiceNo: string) {
  return { source: "email", documentType: "purchase_sale", issueDate: "2026-01-01", invoiceNo,
    deliveryDescription: "Synthetic parser smoke", amountIncVat: 1, vatAmount: 0, currency: "DKK",
    sender: { name: "Synthetic supplier", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK11223344" },
    recipient: { name: "Container Example ApS", address: "Testvej 2, 2100 København Ø", vatOrCvr: "DK12345678" } };
}

async function waitForContainerReadiness(container: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const body = await api(container, "/api/ready");
      const health = await api(container, "/api/health");
      if (body?.ok === true && body?.checks?.workspaceControl === "ok" && body?.checks?.companyLedgers === "ok" && health?.deploymentProfile === "local-container") return;
    } catch { /* startup retry */ }
    await Bun.sleep(100);
  }
  const logs = run(["docker", "logs", container], { allowFailure: true });
  throw new Error(`networkless container did not become ready\n${logs.stderr}${logs.stdout}`);
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
    "docker", "run", "--detach", "--name", first, "--read-only", "--network", "none",
    "--memory", "512m", "--cpus", "1.0", "--pids-limit", "128",
    "--env", "RENTEMESTER_DEPLOYMENT_PROFILE=local-container",
    "--env", "RENTEMESTER_APP_AUTH=off",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs", "/import:rw,nosuid,size=64m",
    "--volume", `${volume}:/workspace`, image,
  ]);
  await waitForContainerReadiness(first);
  if (run(["docker", "exec", first, "id", "-u"]).stdout.trim() !== "1000") {
    throw new Error("container must run as uid 1000");
  }
  const emptyCompaniesBody = await api(first, "/api/companies");
  if (emptyCompaniesBody?.companies?.length !== 0) {
    throw new Error(`fresh volume must start with zero companies: ${JSON.stringify(emptyCompaniesBody)}`);
  }
  const createBody = await api(first, "/api/companies", { name: "Container Example ApS" });
  if (createBody?.company?.slug !== "container-example-aps") {
    throw new Error(`first company creation failed: ${JSON.stringify(createBody)}`);
  }
  const slug = createBody.company.slug;
  const ingest = async (fileName: string, bytes: Uint8Array, invoiceNo: string) => api(first, `/api/companies/${slug}/documents/ingest`, { fileName, fileBase64: Buffer.from(bytes).toString("base64"), metadata: syntheticMetadata(invoiceNo), confirm: true });
  const textDocument = await ingest("synthetic-text.pdf", syntheticTextPdf(), "SYN-001");
  const textId = textDocument?.document?.id;
  if (!Number.isInteger(textId)) throw new Error(`synthetic text PDF ingest failed: ${JSON.stringify(textDocument)}`);
  const historicalTextPath = setLegacyDocumentPath(first, slug, textId);
  const firstParse = await api(first, `/api/companies/${slug}/documents/${textId}/parse`, { confirm: true });
  if (firstParse?.parse?.status !== "ok" || firstParse.parse.pageCount !== 1 || firstParse.parse.cached !== false) throw new Error(`text PDF parse failed: ${JSON.stringify(firstParse)}`);
  const parsedText = await api(first, `/api/companies/${slug}/documents/${textId}/parsed-text`);
  if (parsedText?.pages?.[0]?.text !== SYNTHETIC_PDF_TEXT || parsedText?.pages?.[0]?.itemCount < 2) throw new Error(`verified PDF text/layout missing: ${JSON.stringify(parsedText)}`);
  if (registeredDocumentPath(first, slug, textId) !== historicalTextPath) throw new Error("legacy stored_path was rewritten during container parsing");
  const cachedParse = await api(first, `/api/companies/${slug}/documents/${textId}/parse`, { confirm: true });
  if (cachedParse?.parse?.cached !== true || cachedParse?.parse?.resultHash !== firstParse.parse.resultHash) throw new Error(`PDF parse cache was not reused: ${JSON.stringify(cachedParse)}`);
  const noTextDocument = await ingest("synthetic-no-text.pdf", syntheticNoTextPdf(), "SYN-002");
  const noTextId = noTextDocument?.document?.id;
  const noTextParse = await api(first, `/api/companies/${slug}/documents/${noTextId}/parse`, { confirm: true });
  if (noTextParse?.parse?.status !== "no_text_layer") throw new Error(`no-text PDF outcome failed: ${JSON.stringify(noTextParse)}`);
  run(["docker", "rm", "--force", first]);

  run([
    "docker", "run", "--detach", "--name", second, "--read-only", "--network", "none",
    "--memory", "512m", "--cpus", "1.0", "--pids-limit", "128",
    "--env", "RENTEMESTER_DEPLOYMENT_PROFILE=local-container",
    "--env", "RENTEMESTER_APP_AUTH=off",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs", "/import:rw,nosuid,size=64m",
    "--volume", `${volume}:/workspace`, image,
  ]);
  await waitForContainerReadiness(second);
  const companiesBody = await api(second, "/api/companies");
  if (
    companiesBody?.companies?.length !== 1 ||
    companiesBody.companies[0]?.slug !== "container-example-aps"
  ) throw new Error(JSON.stringify(companiesBody));
  console.log("container integration passed: CLI example, constrained networkless non-root read-only runtime, legacy host-path PDF text/layout, cache, no-text outcome, persisted restart");
} finally {
  run(["docker", "rm", "--force", first], { allowFailure: true });
  run(["docker", "rm", "--force", second], { allowFailure: true });
  run(["docker", "volume", "rm", "--force", volume], { allowFailure: true });
  run(["docker", "image", "rm", "--force", image], { allowFailure: true });
}
