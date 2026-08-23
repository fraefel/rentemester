import { companyRootForSlug, listWorkspaceCompanies, resolveWorkspaceRoot } from "../core/workspace";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "../core/workspace-snapshot";
import { enforceMutationActorPolicy, isCanonicalActorId } from "../cli-actor";
import type { CommandContext, CommandDispatch } from "../cli-dispatch";

function confirmed(ctx: CommandContext): boolean {
  if ((ctx.arg("--confirm") ?? "").trim().toLowerCase() === "yes") return true;
  ctx.emitResult({ ok: false, errors: ["--confirm yes required"] });
  return false;
}

function actor(ctx: CommandContext): { createdBy: string; createdByProgram: string } {
  const createdBy = ctx.cliActor ?? ctx.inferredMutationActor();
  if (!createdBy || !isCanonicalActorId(createdBy)) ctx.fatal("a canonical --actor is required");
  return { createdBy, createdByProgram: ctx.cliActorVia ?? "rentemester-cli" };
}

export function register(dispatch: CommandDispatch): void {
  dispatch.on("workspace", "snapshot", (ctx) => {
    if (!confirmed(ctx)) return;
    const workspaceArg = ctx.trimToNull(ctx.arg("--workspace"));
    const outPath = ctx.trimToNull(ctx.arg("--out"));
    if (!workspaceArg || !outPath) ctx.fatal("workspace snapshot requires --workspace and --out");
    const workspaceRoot = resolveWorkspaceRoot(workspaceArg!);
    const resolvedActor = actor(ctx);
    for (const company of listWorkspaceCompanies(workspaceRoot)) {
      enforceMutationActorPolicy(
        ctx.commandKey,
        companyRootForSlug(workspaceRoot, company.slug),
        resolvedActor.createdBy,
        ctx.cliActorVia,
        ctx.fatal,
      );
    }
    ctx.emitResult(createWorkspaceSnapshot(workspaceRoot, {
      outPath: outPath!,
      createdAt: ctx.arg("--at"),
      ...resolvedActor,
    }) as Record<string, unknown>);
  });

  dispatch.on("workspace", "restore", (ctx) => {
    if (!confirmed(ctx)) return;
    const snapshotPath = ctx.trimToNull(ctx.arg("--snapshot"));
    const targetWorkspaceRoot = ctx.trimToNull(ctx.arg("--target-workspace"));
    if (!snapshotPath || !targetWorkspaceRoot) {
      ctx.fatal("workspace restore requires --snapshot and --target-workspace");
    }
    ctx.emitResult(restoreWorkspaceSnapshot({
      snapshotPath: snapshotPath!,
      targetWorkspaceRoot: resolveWorkspaceRoot(targetWorkspaceRoot!),
      ...actor(ctx),
    }) as Record<string, unknown>);
  });
}
