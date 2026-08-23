import { migrate } from "../core/db";
import {
  approveAndPostAccountingDraft,
  createAccountingDraft,
  getAccountingDraft,
  listAccountingDrafts,
  rejectAccountingDraft,
  reviseAccountingDraft,
  submitAccountingDraft,
} from "../core/accounting-drafts";
import type { JournalEntryInput } from "../core/ledger";
import { openCommandDb, readJsonObjectCliInput, type CommandContext, type CommandDispatch } from "../cli-dispatch";

function actorInput(ctx: CommandContext): { createdBy: string; createdByProgram: string } {
  const createdBy = ctx.cliActor ?? process.env.RENTEMESTER_ACTOR ?? ctx.inferredMutationActor();
  if (!createdBy) ctx.fatal("accounting-draft mutations require an actor");
  return {
    createdBy,
    createdByProgram: ctx.cliActorVia ?? process.env.RENTEMESTER_ACTOR_VIA ?? "rentemester-cli",
  };
}

function required(ctx: CommandContext, flag: string): string {
  const value = ctx.trimToNull(ctx.arg(flag));
  if (!value) ctx.fatal(`Missing required ${flag} <value>`);
  return value;
}

function emitMutation(ctx: CommandContext, operation: () => unknown): void {
  try {
    ctx.emitResult({ ok: true, accountingDraft: operation() });
  } catch (error) {
    ctx.emitResult({ ok: false, errors: [error instanceof Error ? error.message : String(error)] });
  }
}

export function register(dispatch: CommandDispatch): void {
  dispatch.on("accounting-draft", "create", (ctx) => {
    const inputPath = required(ctx, "--input");
    const db = openCommandDb(ctx);
    try {
      migrate(db);
      const payload = readJsonObjectCliInput(ctx, inputPath, "--input") as unknown as JournalEntryInput;
      emitMutation(ctx, () => createAccountingDraft(db, required(ctx, "--draft-id"), payload, actorInput(ctx)));
    } finally {
      db.close();
    }
  });

  dispatch.on("accounting-draft", "revise", (ctx) => {
    const inputPath = required(ctx, "--input");
    const db = openCommandDb(ctx);
    try {
      migrate(db);
      const payload = readJsonObjectCliInput(ctx, inputPath, "--input") as unknown as JournalEntryInput;
      emitMutation(ctx, () => reviseAccountingDraft(db, required(ctx, "--draft-id"), required(ctx, "--expected-event-hash"), payload, actorInput(ctx)));
    } finally {
      db.close();
    }
  });

  dispatch.on("accounting-draft", "submit", (ctx) => {
    const db = openCommandDb(ctx);
    try {
      migrate(db);
      emitMutation(ctx, () => submitAccountingDraft(db, required(ctx, "--draft-id"), required(ctx, "--expected-event-hash"), actorInput(ctx)));
    } finally {
      db.close();
    }
  });

  dispatch.on("accounting-draft", "reject", (ctx) => {
    const db = openCommandDb(ctx);
    try {
      migrate(db);
      emitMutation(ctx, () => rejectAccountingDraft(db, required(ctx, "--draft-id"), required(ctx, "--expected-event-hash"), required(ctx, "--reason"), actorInput(ctx)));
    } finally {
      db.close();
    }
  });

  dispatch.on("accounting-draft", "approve-and-post", (ctx) => {
    if (ctx.arg("--confirm") !== "yes") ctx.fatal("approve-and-post requires --confirm yes");
    const db = openCommandDb(ctx);
    try {
      migrate(db);
      emitMutation(ctx, () => approveAndPostAccountingDraft(db, required(ctx, "--draft-id"), required(ctx, "--expected-event-hash"), actorInput(ctx)));
    } finally {
      db.close();
    }
  });

  dispatch.on("accounting-draft", "show", (ctx) => {
    const db = openCommandDb(ctx);
    try {
      migrate(db);
      ctx.emitResult({ ok: true, accountingDraft: getAccountingDraft(db, required(ctx, "--draft-id")) });
    } finally {
      db.close();
    }
  });

  dispatch.on("accounting-draft", "list", (ctx) => {
    const db = openCommandDb(ctx);
    try {
      migrate(db);
      ctx.emitResult({ ok: true, accountingDrafts: listAccountingDrafts(db) });
    } finally {
      db.close();
    }
  });
}
